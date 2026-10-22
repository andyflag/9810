// The build generates assets.json after Vite finishes. Keep type checking
// available in a clean checkout before that generated file exists.
declare module '*assets.json' {
  const assets: Record<string, { content: string; type: string }>;
  export default assets;
}
