// Bundled transcript for /dev/stream-lab. Built as string concatenation
// (not a template literal) so the markdown's own inline-code backticks and
// fenced code block never collide with a template delimiter — same style
// the old stream-tuner's SCRIPT array used for its segment text.

/** One ThinkingContent block's worth of plain-prose reasoning that would
 * logically precede the reply below — no markdown syntax, since thinking
 * blocks render as plain paced text, not through the markdown pipeline. */
export const FIXTURE_THINKING =
  "The user is asking for a small, dependency-free debounce helper that plays well with TypeScript's generics, so the first thing to pin down is what \"plays well\" means here: the wrapped function's parameter types need to survive the wrap unchanged, and the returned function needs a way to cancel a pending call, since debounced search-as-you-type handlers are the most common use case and almost always want an unmount-time escape hatch.\n\n" +
  "There are two behaviorally different debounce flavors floating around in most codebases: trailing-edge, which waits for a quiet period and then fires once with the last arguments received, and leading-edge, which fires immediately and then ignores calls until the quiet period elapses. Most people mean trailing-edge by default, and folding both into one function through an options bag tends to produce more branches than a short example deserves, so trailing-edge with an explicit cancel method is the right scope.\n\n" +
  "Worth flagging up front that debounce and throttle get confused constantly, and a short side-by-side comparison will do more to fix that than another paragraph of prose — better to show the two once the implementation itself is out of the way, rather than interleave the distinction into the code explanation.\n\n" +
  "For the implementation, plain setTimeout and clearTimeout keep it dependency-free and easy to paste into any project. A generic type parameter capturing the wrapped function's argument tuple is enough to get full type inference at every call site without needing separate overloads for each arity.";

/** One TextContent block's worth of markdown reply: opening paragraph,
 * heading, bulleted list, inline code, a fenced code block, another
 * paragraph, a table, and a closing paragraph — in that order. */
export const FIXTURE_REPLY =
  "Here's a small, dependency-free `debounce` utility written in TypeScript. It wraps any function so that rapid, repeated calls collapse into a single invocation once the calls stop arriving for a configurable quiet period \u2014 the classic pattern behind search boxes, resize handlers, and autosave.\n\n" +
  "## Implementation\n\n" +
  "A few design goals shaped the version below:\n\n" +
  "- **Trailing-edge only** \u2014 the wrapped function fires once, after calls go quiet, with the *last* set of arguments it received.\n" +
  "- **Fully generic** \u2014 the returned function keeps the exact parameter types of the original, so callers get full autocomplete and type-checking.\n" +
  "- **Cancelable** \u2014 a `.cancel()` method clears any pending call, which matters for cleaning up inside a `useEffect` return.\n" +
  "- **Zero dependencies** \u2014 just `setTimeout` and `clearTimeout`, nothing to install.\n\n" +
  "The core trick is closing over a single `timeoutId` variable per wrapped function. Every call to the debounced function runs `clearTimeout(timeoutId)` before scheduling a new one with `setTimeout`, so only the *last* call in a burst ever survives long enough to fire. `cancel()` simply exposes that same `clearTimeout` call to the caller.\n\n" +
  "```ts\n" +
  "export function debounce<Args extends unknown[]>(\n" +
  "  fn: (...args: Args) => void,\n" +
  "  waitMs: number,\n" +
  "): { (...args: Args): void; cancel: () => void } {\n" +
  "  let timeoutId: ReturnType<typeof setTimeout> | undefined;\n" +
  "  const debounced = (...args: Args): void => {\n" +
  "    if (timeoutId !== undefined) clearTimeout(timeoutId);\n" +
  "    timeoutId = setTimeout(() => {\n" +
  "      timeoutId = undefined;\n" +
  "      fn(...args);\n" +
  "    }, waitMs);\n" +
  "  };\n" +
  "  debounced.cancel = (): void => {\n" +
  "    if (timeoutId !== undefined) clearTimeout(timeoutId);\n" +
  "    timeoutId = undefined;\n" +
  "  };\n" +
  "  return debounced;\n" +
  "}\n" +
  "```\n\n" +
  "Throttling solves a related but different problem, and the two get mixed up often enough that it is worth putting them side by side rather than describing the difference in prose alone:\n\n" +
  "| Aspect | Debounce | Throttle |\n" +
  "| --- | --- | --- |\n" +
  "| Fires | Once, after calls go quiet | At most once per fixed interval |\n" +
  "| Best for | Search input, autosave | Scroll and resize handlers |\n" +
  "| Guarantee | Last call always wins | Regular cadence, may drop calls |\n" +
  "| Typical wait | 200-500ms | 50-150ms |\n\n" +
  "Either helper is small enough to inline directly into a project rather than reaching for a utility library, and keeping the generic signature intact means TypeScript catches a mismatched argument list at the call site instead of at runtime.";
