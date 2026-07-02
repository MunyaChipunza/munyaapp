declare const Netlify:
  | {
      env: { get(name: string): string | undefined };
      context?: { deploy?: { context?: string } };
    }
  | undefined;

export function getEnv(name: string): string | undefined {
  if (typeof Netlify !== "undefined") {
    const value = Netlify.env.get(name);
    if (value) return value;
  }
  return process.env[name];
}

export function isProductionDeploy(): boolean {
  if (typeof Netlify === "undefined") return process.env.CONTEXT === "production";
  return Netlify.context?.deploy?.context === "production";
}
