/** Markdown files imported with `with { type: "text" }` (embedded by bun build --compile). */
declare module "*.md" {
  const text: string;
  export default text;
}
