// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnimatedPaperclipIcon, PaperclipLoading } from "./AnimatedPaperclipIcon";

describe("AnimatedPaperclipIcon", () => {
  it("renders the Bionic logo with a pulse and is hidden from assistive tech", () => {
    const html = renderToStaticMarkup(<AnimatedPaperclipIcon />);

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("bionic-logo-pulse");
    expect(html).toContain("<image");
    expect(html).toContain("bionic-logo.png");
  });
});

describe("PaperclipLoading", () => {
  it("renders an accessible full-page loading state", () => {
    const html = renderToStaticMarkup(<PaperclipLoading />);

    expect(html).toContain('role="status"');
    expect(html).toContain("min-h-dvh");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('<span class="sr-only">Loading…</span>');
  });

  it("allows containing layouts to override the full-page height", () => {
    const html = renderToStaticMarkup(<PaperclipLoading className="min-h-0" />);

    expect(html).toContain("min-h-0");
    expect(html).not.toContain("min-h-dvh");
  });
});
