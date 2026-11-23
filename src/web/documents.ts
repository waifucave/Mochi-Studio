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

/**
 * What the About says: the app and its version, which app it is, its
 * license, and where to report a problem.
 */
export function aboutText(o: { version: string; desktop: boolean; repository: string }): string {
  return [
    `Mochi Studio ${o.version}`,
    o.desktop ? 'The desktop app.' : 'The browser app.',
    '',
    'An open-source live-avatar app, built on the Mochi2D runtime.',
    `Source, releases and issues: ${o.repository}`,
    '',
    'License: MIT. The third-party software it ships with, and their licenses, are listed in',
    'THIRD_PARTY_NOTICES.md: beside the desktop app, and in the source repository.',
    'The terms of use: TERMS.md, also under Settings > Collab.',
    '',
    'A problem? Main menu > Log > "Save for a bug report…", then open an issue at',
    `${o.repository}/issues and attach the file. A security problem: report it`,
    `privately instead, at ${o.repository}/security (SECURITY.md).`,
  ].join('\n');
}

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
