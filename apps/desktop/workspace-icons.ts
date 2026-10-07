/** Static SVGs only; filenames and file content never become markup. */
export function workspaceIcon(
  kind:
    | 'folder'
    | 'folder-open'
    | 'file'
    | 'markdown'
    | 'close'
    | 'expand'
    | 'collapse'
    | 'fullscreen'
    | 'restore'
    | 'refresh',
): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.icon = kind;
  const paths = {
    folder: 'M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    'folder-open': 'M3 17V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v2M3 20l3-9h16l-3 9Z',
    file: 'M14 2H5v20h14V7Zm0 0v5h5M8 12h8M8 16h8',
    markdown: 'M14 2H5v20h14V7Zm0 0v5h5',
    close: 'm6 6 12 12M6 18 18 6',
    expand: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm3 0v18',
    collapse: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm11 0v18',
    fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
    restore: 'M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5',
    refresh: 'M20 7v5h-5M20 12a8 8 0 1 0-2 6M20 7l-3-3',
  };
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[kind]);
  svg.append(path);
  if (kind === 'markdown') {
    path.setAttribute('fill', '#477bea');
    path.setAttribute('stroke', '#477bea');
    const label = document.createElementNS(svg.namespaceURI, 'text');
    label.textContent = 'MD';
    label.setAttribute('x', '12');
    label.setAttribute('y', '17');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '6');
    label.setAttribute('font-weight', '700');
    label.setAttribute('fill', 'white');
    label.setAttribute('stroke', 'none');
    svg.append(label);
  }
  return svg;
}
