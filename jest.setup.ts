// Registers @testing-library/jest-dom matchers (toBeInTheDocument, toHaveRole,
// etc.). Harmless under the node environment used by the lib/API suites — those
// tests simply never call the DOM matchers. Component tests (*.test.tsx) run
// under jsdom via a per-file `@jest-environment jsdom` docblock.
import "@testing-library/jest-dom";

// jsdom does not implement Element.scrollTo. ChatPanel calls it in an effect to
// keep the message list pinned to the latest message. Provide a no-op so the
// effect doesn't throw under jsdom (purely presentational; nothing to assert).
if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {
    /* no-op for jsdom */
  };
}
