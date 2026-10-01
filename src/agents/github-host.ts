export const GITHUB_PUBLIC_HOST = "github.com";
export const GITHUB_PUBLIC_API_BASE_URL = "https://api.github.com";

export function isGitHubCloudHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === GITHUB_PUBLIC_HOST || normalized.endsWith(".ghe.com");
}
