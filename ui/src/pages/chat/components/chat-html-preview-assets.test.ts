import type { SessionsFilesAssetsResult } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { prepareHtmlPreviewAssets } from "./chat-html-preview-assets.ts";

function asset(ref: string, mimeType: string, text: string) {
  return { ref, mimeType, content: Buffer.from(text).toString("base64") };
}

function reader(files: ReturnType<typeof asset>[]) {
  return vi.fn(async (refs: string[]): Promise<SessionsFilesAssetsResult> => ({
    assets: refs.map(
      (ref) => files.find((file) => file.ref === ref) ?? { ref, error: "not_found" },
    ),
  }));
}

describe("session file HTML assets", () => {
  it("inlines images, a stylesheet and its nested image, and module scripts without rewriting document bytes", async () => {
    const prefix = "<!DoCtYpE html>\r\n<!-- authored -->\n";
    const suffix = '<a HREF="#details">Details</a>\r\n';
    const source =
      prefix +
      '<img class=hero src="a.png"><link rel="stylesheet" href="styles/a.css" media="screen"><script type="module" src="run.js" SRC="ignored.js"></script>' +
      suffix;
    const fetch = reader([
      asset("a.png", "image/png", "image"),
      asset(
        "styles/a.css",
        "text/css",
        '@import "other.css"; .hero{background:url(../b.png)} @font-face{src:url(font)} .label{src:url(a.woff2)}',
      ),
      asset("styles/../b.png", "image/png", "background"),
      asset("run.js", "text/javascript", 'window.label="café";'),
    ]);
    const result = await prepareHtmlPreviewAssets(source, true, fetch);
    expect(result).toEqual({
      html:
        prefix +
        '<img class=hero src="data:image/png;base64,aW1hZ2U="><style media="screen">@import "other.css"; .hero{background:url("data:image/png;base64,YmFja2dyb3VuZA==")} @font-face{src:url(font)} .label{src:url(a.woff2)}</style><script type="module">window.label="café";</script>' +
        suffix,
      omitted: 0,
    });
    expect(fetch.mock.calls).toEqual([
      [["a.png", "styles/a.css", "run.js"]],
      [["styles/../b.png"]],
    ]);
  });

  it("keeps CSS-escaped URL fragments from terminating an inline style block", async () => {
    const source = '<style>.mark{background:url("icon.svg#\\3c /style>")}</style>';
    const fetch = reader([asset("icon.svg#</style>", "image/svg+xml", "a")]);
    expect(await prepareHtmlPreviewAssets(source, true, fetch)).toEqual({
      html: '<style>.mark{background:url("data:image/svg+xml;base64,YQ==#%3C/style%3E")}</style>',
      omitted: 0,
    });
  });

  it("handles media srcsets and inline CSS while preserving remote URLs, fonts, CSS strings and comments", async () => {
    const source =
      '<style>/* url(fake.png) */p::after{content:"url(fake.png)"}p{background:url("a.png")} @font-face{src:url(font)}</style><img srcset="a.png 1x, data:image/png;base64,Yg== 2x, b.png 3x"><source src="a.png" srcset="b.png 2x"><video src="clip.mp4" poster="a.png"></video><audio src="sound.mp3"></audio><input type="IMAGE" src="a.png"><p style="background:url(a.png)"></p><img src="//example.test/a.png"><img src="https://example.test/a.png"><img src="#image"><img src="/absolute.png">';
    const fetch = reader([
      asset("a.png", "image/png", "a"),
      asset("b.png", "image/png", "b"),
      asset("clip.mp4", "video/mp4", "v"),
      asset("sound.mp3", "audio/mpeg", "s"),
    ]);
    const result = await prepareHtmlPreviewAssets(source, false, fetch);
    expect(result.omitted).toBe(0);
    expect(result.html).toContain(
      'srcset="data:image/png;base64,YQ== 1x, data:image/png;base64,Yg== 2x, data:image/png;base64,Yg== 3x"',
    );
    expect(result.html).toContain(
      '<source src="data:image/png;base64,YQ==" srcset="data:image/png;base64,Yg== 2x">',
    );
    expect(result.html).toContain(
      '<video src="data:video/mp4;base64,dg==" poster="data:image/png;base64,YQ==">',
    );
    expect(result.html).toContain('<audio src="data:audio/mpeg;base64,cw==">');
    expect(result.html).toContain('<input type="IMAGE" src="data:image/png;base64,YQ==">');
    expect(result.html).toContain('style="background:url(&quot;data:image/png;base64,YQ==&quot;)"');
    expect(result.html).toContain(
      '/* url(fake.png) */p::after{content:"url(fake.png)"}p{background:url("data:image/png;base64,YQ==")} @font-face{src:url(font)}',
    );
    expect(result.html).toContain(
      '<img src="//example.test/a.png"><img src="https://example.test/a.png"><img src="#image"><img src="/absolute.png">',
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(["a.png", "b.png", "clip.mp4", "sound.mp3"]);
  });

  it.each(['<base href="https://example.test/">', '<base href="">'])(
    "leaves authored base-href documents untouched (%s)",
    async (base) => {
      const source =
        base + '<img src="a.png"><link rel="stylesheet" href="a.css"><script src="a.js"></script>';
      const fetch = reader([]);
      expect(await prepareHtmlPreviewAssets(source, true, fetch)).toEqual({
        html: source,
        omitted: 0,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reports omitted assets once and leaves missing, denied and oversized references intact", async () => {
    const source =
      '<img src=missing.png><img src=missing.png><img src="denied.png"><script src="large.js"></script>';
    const fetch = vi.fn(async (): Promise<SessionsFilesAssetsResult> => ({
      assets: [
        { ref: "missing.png", error: "not_found" },
        { ref: "denied.png", error: "outside_session_boundary" },
        { ref: "large.js", error: "too_large" },
      ],
    }));
    expect(await prepareHtmlPreviewAssets(source, true, fetch)).toEqual({
      html: source,
      omitted: 3,
    });
  });

  it("keeps each round within the protocol ref cap and reports excess and failed reads", async () => {
    const source = Array.from({ length: 65 }, (_, i) => `<img src="${i}.png">`).join("");
    const fetch = vi.fn(async (): Promise<SessionsFilesAssetsResult> => {
      throw new Error("Disconnected");
    });
    expect(await prepareHtmlPreviewAssets(source, true, fetch)).toEqual({
      html: source,
      omitted: 65,
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(Array.from({ length: 64 }, (_, i) => `${i}.png`));
  });
});
