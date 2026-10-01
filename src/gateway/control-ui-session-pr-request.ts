import { gitHubPublicApi } from "./github-public-api.js";

/** Session reads pin the admitted host, endpoint and credential across every auxiliary request. */
export function prepareSessionPullRequestGitHubRead(
  host: string,
  fetchImpl: typeof fetch,
  assertAccess: () => void,
  options: { optionalAuth?: boolean } = {},
) {
  const optionalAuth = options.optionalAuth !== false;
  const selected = gitHubPublicApi.resolveGitHubApiCredentialScope(undefined, host);
  const assertCurrent = () => {
    assertAccess();
    if (
      gitHubPublicApi.resolveGitHubApiCredentialScope(undefined, host).cacheScope !==
      selected.cacheScope
    ) {
      throw new gitHubPublicApi.ControlUiGitHubError(
        409,
        "GitHub identity changed; reopen the session pull request",
      );
    }
  };
  const identity = { assertSelected: assertCurrent, revalidate: async () => assertCurrent() };
  return {
    ...selected,
    host,
    assertCurrent,
    async request(
      this: void,
      url: string,
      maxBytes?: number,
      signal?: AbortSignal,
      beforeRedirect?: (url: URL) => Promise<void>,
    ) {
      assertCurrent();
      const readJson = async (token: string | undefined) =>
        gitHubPublicApi.readGitHubJsonResponse(
          await gitHubPublicApi.fetchGitHubApi(
            url,
            fetchImpl,
            token,
            beforeRedirect,
            identity,
            undefined,
            signal,
            undefined,
            selected.apiBaseUrl,
          ),
          maxBytes,
        );
      const value = optionalAuth
        ? await gitHubPublicApi.withOptionalGitHubAuth(selected.token, readJson)
        : await readJson(selected.token);
      assertCurrent();
      return value;
    },
  };
}
