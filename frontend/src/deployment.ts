export const gatewayAuth = import.meta.env.VITE_SPEC_GATEWAY_AUTH === "1"

export function publicPath(path = "") {
  return import.meta.env.BASE_URL + path.replace(/^\//, "")
}

export function apiHeaders(token: string): Record<string, string> {
  // Leave Authorization to the browser's Basic auth in server-auth deployments.
  return gatewayAuth
    ? { "Content-Type": "application/json" }
    : { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
}
