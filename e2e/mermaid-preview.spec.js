'use strict';

const path = require('node:path');
const { test, expect, makeRepo, openPlainTerminal, box } = require('./fixtures');

const DETAILS_ID = 'mermaid-private-details';
const PRIVATE_LABEL = 'private-main-document-canary-663h';
const PRIVATE_URL = 'https://example.invalid/private-663h';

function markdown(source) {
  return '```mermaid\n' + source + '\n```\n';
}

test('Markdown Mermaid loads once under Electron CSP, isolates details and fits a narrow Gantt preview', async ({ home, env, launch }) => {
  const repo = makeRepo(home, env, {
    'diagrams.md': markdown('flowchart LR\n  A[Start] --> B[Done]')
      + '\n' + markdown('sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Ready'),
    'details.md': markdown('sequenceDiagram\n  participant Alice\n  participant Bob\n  details Alice: ' + DETAILS_ID + '\n  Alice->>Bob: Hello'),
    'gantt.md': markdown('gantt\n  title Narrow schedule\n  dateFormat YYYY-MM-DD\n  section Work\n  Build :a1, 2026-01-01, 2d\n  Test :after a1, 1d'),
  });
  const { page } = await launch();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.evaluate(({ id, label, url }) => {
    const privateElement = document.createElement('div');
    privateElement.id = id;
    privateElement.hidden = true;
    privateElement.textContent = JSON.stringify({ links: { [label]: url }, properties: { note: label } });
    document.body.appendChild(privateElement);
    window.mermaidCspViolations = [];
    window.mermaidObservedDocuments = 0;
    const observed = new WeakSet();
    const observeDocument = doc => {
      if (!doc || observed.has(doc)) return;
      observed.add(doc);
      window.mermaidObservedDocuments++;
      doc.addEventListener('securitypolicyviolation', event => {
        window.mermaidCspViolations.push({
          document: doc.URL,
          directive: event.effectiveDirective,
          blockedURI: event.blockedURI,
        });
      });
    };
    observeDocument(document);
    window.mermaidCspObserver = new MutationObserver(() => {
      for (const frame of document.querySelectorAll('iframe.mermaid-render-frame')) {
        observeDocument(frame.contentDocument);
      }
    });
    window.mermaidCspObserver.observe(document.body, { childList: true, subtree: true });
  }, { id: DETAILS_ID, label: PRIVATE_LABEL, url: PRIVATE_URL });
  await openPlainTerminal(page);
  const sessionId = await page.evaluate(() => activeSessionId);
  expect(sessionId).toBeTruthy();
  const preview = page.locator('#changes-diff-preview');
  const frame = page.locator('iframe.mermaid-render-frame');
  const openMarkdown = async name => {
    await page.evaluate(([id, filePath]) => window.openFileInPanel(id, filePath),
      [sessionId, path.join(repo, name)]);
    await expect(preview).toBeVisible();
  };

  await test.step('flowchart and sequence render through the real local bundle', async () => {
    await openMarkdown('diagrams.md');
    for (const index of [0, 1]) {
      const diagram = preview.locator('[data-preview-mermaid="' + index + '"]');
      await expect(diagram.locator(':scope > svg')).toHaveCount(1);
      expect((await box(diagram.locator(':scope > svg'))).width).toBeGreaterThan(0);
    }
    await expect(preview.locator('.mermaid-error, pre, code.language-mermaid')).toHaveCount(0);
    await expect(frame).toHaveCount(1);
    expect(await frame.evaluate(el => el.contentDocument.URL)).toBe('about:blank');
    expect(await frame.evaluate(el => el.contentDocument.querySelector('script').src)).toMatch(/^file:.*\/mermaid-bundle\.js$/);
    await expect.poll(() => page.evaluate(() => window.mermaidObservedDocuments)).toBe(2);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => window.mermaidCspViolations)).toEqual([]);
  });

  await test.step('the preview pre-check refuses details referencing a main-page element', async () => {
    await expect(page.locator('#' + DETAILS_ID)).toContainText(PRIVATE_LABEL);
    await openMarkdown('details.md');
    await expect(preview.locator('.mermaid-diagram')).toHaveCount(1);
    await expect(preview.locator('.mermaid-error')).toHaveCount(1);
    await expect(preview.locator('.mermaid-diagram > svg')).toHaveCount(0);
    await expect(preview).not.toContainText(PRIVATE_LABEL);
    expect(await preview.innerHTML()).not.toContain(PRIVATE_URL);
    await expect(preview.locator('[id*="_popup"], .actorPopupMenu, .actorPopupMenuPanel, foreignObject')).toHaveCount(0);
    await expect(frame).toHaveCount(1);
  });

  await test.step('the scoped renderer isolates details when the pre-check is bypassed', async () => {
    const svg = await page.evaluate(async id => {
      const renderDocument = document.querySelector('iframe.mermaid-render-frame').contentDocument;
      const privateElement = renderDocument.importNode(document.getElementById(id), true);
      const scratch = renderDocument.createElement('div');
      renderDocument.body.append(privateElement, scratch);
      try {
        const source = 'sequenceDiagram\n  participant Alice\n  participant Bob\n  details Alice: ' + id + '\n  Alice->>Bob: Hello';
        const { svg } = await window.renderScopedMarkdownDiagram(window.previewMermaid, 'preview-mermaid-dom-guard', source, scratch);
        return svg;
      } finally {
        scratch.remove();
        privateElement.remove();
      }
    }, DETAILS_ID);
    expect(svg).toContain('<svg');
    expect(svg).toContain('Hello');
    expect(svg).not.toContain(PRIVATE_LABEL);
    expect(svg).not.toContain(PRIVATE_URL);
  });

  await test.step('a newly rendered Gantt fits after narrowing the panel', async () => {
    const panel = page.locator('#file-panel');
    const originalWidth = (await box(panel)).width;
    const handle = await box(page.locator('#file-panel-resize-handle'));
    const targetWidth = 300;
    expect(originalWidth).toBeGreaterThan(targetWidth);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + originalWidth - targetWidth, handle.y + handle.height / 2);
    await page.mouse.up();
    await expect.poll(async () => (await box(panel)).width).toBeLessThanOrEqual(targetWidth + 1);
    await openMarkdown('gantt.md');
    const svg = preview.locator('.mermaid-diagram > svg');
    await expect(svg).toHaveCount(1);
    await expect(preview.locator('.mermaid-error, pre, code.language-mermaid')).toHaveCount(0);
    const svgWidth = (await box(svg)).width;
    const previewWidth = await preview.evaluate(el => el.clientWidth);
    expect(svgWidth).toBeGreaterThan(0);
    expect.soft(svgWidth, 'Gantt SVG must fit the narrowed preview').toBeLessThanOrEqual(previewWidth + 1);
  });

  await expect(frame).toHaveCount(1);
  expect(await page.evaluate(() => window.mermaidCspViolations)).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
