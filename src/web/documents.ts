/**
 * Documents the app shows itself, bundled with the pages, so they need no
 * network and no web address: the terms, the signaling server's privacy
 * notice, and the collaboration page's "Hosting a server" section.
 */
import collaboration from '../../docs/collaboration.md?raw';
import privacy from '../../PRIVACY.md?raw';
import terms from '../../TERMS.md?raw';
import { h } from './dom';

/** A Markdown section, from its `## ` heading to the next one. */
export function markdownSection(md: string, heading: string): string {
  const start = md.indexOf(`\n## ${heading}\n`);
  if (start < 0) return '';
  const next = md.indexOf('\n## ', start + 4);
  return md.slice(start + 1, next < 0 ? undefined : next).trim();
}

export const TERMS_TEXT = terms.trim();
export const PRIVACY_TEXT = privacy.trim();
export const HOSTING_TEXT = markdownSection(collaboration, 'Hosting a server');

/** Shows a document in a dialog over the app, as plain text; Escape or Close shuts it. */
export function showDocument(title: string, text: string): HTMLDialogElement {
  document.querySelector('dialog.doc-dialog')?.remove();
  const d = h(
    'dialog',
    { class: 'doc-dialog', 'aria-label': title },
    h(
      'div',
      { class: 'row' },
      h('h2', {}, title),
      h('button', { class: 'doc-close', onclick: () => d.close() }, 'Close'),
    ),
    h('pre', { class: 'doc-text' }, text),
  ) as HTMLDialogElement;
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

/** A button that looks like a link and opens a document. */
export function documentLink(id: string, label: string, title: string, text: string): HTMLElement {
  return h(
    'button',
    { id, class: 'link', type: 'button', onclick: () => showDocument(title, text) },
    label,
  );
}
