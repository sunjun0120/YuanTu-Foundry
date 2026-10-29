/**
 * The new-tab page's two card illustrations, ported from the reference design.
 *
 * Each card is a still drawing plus a frame-by-frame flip book: on hover or focus of the enclosing
 * `.workspace-new-tab-option`, the frames show one after another through staggered CSS animations (see styles.css).
 * The frames are local SVG files copied to `assets/new-tab/`; the label is text so it follows the locale and theme.
 */
import { useComputedColorScheme } from '@mantine/core';
import { useId, type CSSProperties, type ReactNode } from 'react';

const delay = (ms: number): CSSProperties => ({ '--frame-delay': `${ms}ms` }) as CSSProperties;

/** [asset, y offset, height] for each frame of the file card's front sheet. */
const FILE_FRAMES = [
  ['b36c6', 1.46, 70.041],
  ['7e25d', 2.82, 68.684],
  ['1553d', 4.08, 67.424],
  ['b0251', 5.24, 66.259],
  ['87d14', 6.32, 65.183],
  ['debdf', 7.31, 64.194],
  ['95d34', 8.21, 63.289],
  ['0c87f', 9.04, 62.462],
  ['f711a', 9.79, 61.712],
  ['22504', 10.47, 61.033],
  ['c5425', 11.08, 60.423],
  ['23c12', 11.62, 59.878],
  ['d1fab', 12.11, 59.394],
  ['3d465', 12.53, 58.968],
  ['fb6fa', 12.9, 58.595],
  ['a9af1', 13.23, 58.273],
  ['079a2', 13.5, 57.997],
  ['ee652', 13.74, 57.765],
  ['7c1c4', 13.93, 57.571],
  ['a3447', 14.09, 57.414],
  ['f7908', 14.21, 57.288],
  ['0589f', 14.31, 57.191],
  ['43d58', 14.38, 57.118],
  ['abef4', 14.43, 57.067],
  ['f5fb0', 14.47, 57.033],
  ['0148f', 14.49, 57.013],
  ['0f3ca', 14.5, 57.004],
  ['d687e', 14.5, 57],
] as const;

/** [asset, x offset, width] for each frame of the browser card's spinning globe. */
const BROWSER_FRAMES = [
  ['3da44', 36.77, 32.507],
  ['45362', 37, 37.855],
  ['860e8', 1.43, 65.932],
  ['9c3b2', 10.1, 64.593],
  ['7c031', 0.38, 37.622],
  ['c7877', 5.11, 32.893],
  ['80c6a', 14.01, 36.518],
  ['9641d', 25.35, 36.358],
  ['fd1f2', 37, 32.621],
  ['5064b', 37, 36.976],
  ['7f8a7', -0.94, 59.723],
  ['5ff5c', 0.99, 65.525],
  ['1609b', 5.17, 66.721],
  ['c3c33', 10.91, 64.06],
  ['96791', 17.57, 58.426],
  ['22971', 0.69, 37.308],
  ['55379', 2.71, 35.286],
  ['2032d', 5.7, 32.482],
  ['3dc76', 9.3, 34.919],
  ['6e308', 13.24, 36.343],
  ['c7d5f', 17.28, 36.946],
  ['abcb9', 21.25, 36.914],
  ['3c121', 25.03, 36.418],
  ['4980e', 28.52, 35.609],
  ['00705', 31.67, 34.613],
  ['11818', 34.46, 33.534],
  ['325ff', 36.88, 32.454],
  ['aabdf', 37, 33.364],
  ['eac35', 37, 34.141],
  ['88631', 37, 34.715],
  ['5b01b', 37, 35.124],
  ['59e87', 37, 35.399],
  ['2e5a9', 37, 35.562],
  ['3f857', 37, 35.63],
  ['b65ad', 37, 35.547],
  ['d1197', 37, 35.144],
  ['c7433', 37, 34.407],
  ['dfb13', 37, 33.32],
  ['3e224', 36.03, 32.851],
  ['05c5e', 32.98, 34.13],
  ['0797c', 29.88, 35.208],
  ['ef21c', 26.91, 36.021],
  ['ae49e', 24.23, 36.557],
  ['e1b9c', 21.98, 36.851],
  ['d5804', 20.29, 36.971],
  ['18c00', 19.27, 36.999],
] as const;

export function FileCardArt({ label }: { label: string }): ReactNode {
  const dark = useComputedColorScheme('light') === 'dark';
  const gradientId = `file-paper-${useId().replace(/:/g, '')}`;
  const fileAsset = (id: string): string => `./assets/new-tab/file${dark ? '-dark' : ''}/${id}.svg`;
  return (
    <svg className="new-tab-art file-card-art" viewBox="0 0 254 210" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2=".08" y2="0">
          <stop stopColor="var(--ws-art-paper-front)" />
          <stop offset="1" stopColor="var(--ws-art-paper-front-end)" />
        </linearGradient>
      </defs>
      <text x="127" y="43" textAnchor="middle" className="new-tab-art-label">
        {label}
      </text>
      <image href={fileAsset('252aa')} x="63.65" y="83" width="124.7" height="58" />
      <rect className="file-paper-back" x="92" y="92" width="70" height="74" rx="5" />
      <rect
        className="file-paper-front"
        x="92"
        y="92"
        width="70"
        height="74"
        rx="5"
        fill={`url(#${gradientId})`}
      />
      <image
        className="file-front-rest"
        href={fileAsset('f748b')}
        x="57.8"
        y="110.5"
        width="138.4"
        height="71.5"
      />
      {FILE_FRAMES.map(([id, y, height], index) => (
        <image
          key={id}
          className="file-front-frame"
          href={fileAsset(id)}
          x="56"
          y={110.5 + y}
          width="142"
          height={height}
          style={delay(((index + 1) * 1000) / 60)}
        />
      ))}
      <image
        className="file-front-final"
        href={fileAsset('8d5a6')}
        x="56"
        y="125"
        width="142"
        height="57"
      />
      <image
        className="file-front-line"
        href={fileAsset('47602')}
        x="70"
        y="167.5"
        width="114.5"
        height="1"
      />
    </svg>
  );
}

export function BrowserCardArt({ label }: { label: string }): ReactNode {
  const dark = useComputedColorScheme('light') === 'dark';
  const browserAsset = (id: string): string =>
    `./assets/new-tab/browser${dark ? '-dark' : ''}/${id}.svg`;
  return (
    <svg className="new-tab-art browser-card-art" viewBox="0 0 254 210" aria-hidden="true">
      <text x="127" y="43" textAnchor="middle" className="new-tab-art-label">
        {label}
      </text>
      <g transform="translate(127 131.5) scale(.9) translate(-127 -125.5)">
        <rect className="browser-window" x="37" y="69" width="181" height="113" rx="7" />
        <image href={browserAsset('cc297')} x="37.5" y="90.5" width="180" height="1" />
        {['2e8b0', '25ec1', '5f90a'].map((id, index) => (
          <image
            key={id}
            href={browserAsset(id)}
            x={46 + index * 13}
            y="77"
            width="9"
            height="9"
            className={`browser-dot browser-dot-${index}`}
          />
        ))}
        <image href={browserAsset('804fb')} x="89" y="100" width="76" height="76" />
        <g className="browser-rest-meridians">
          <image href={browserAsset('27724')} x="107.5" y="100" width="19.5" height="76" />
          <image
            href={browserAsset('47266')}
            x="125.5"
            y="100"
            width="19.5"
            height="76"
            transform="translate(271 0) scale(-1 1)"
          />
        </g>
        <image href={browserAsset('0dadd')} x="89" y="137.5" width="76" height="1" />
        {BROWSER_FRAMES.map(([id, x, width], index) => (
          <image
            key={id}
            className="browser-frame"
            href={browserAsset(id)}
            x={89 + x}
            y="100.5"
            width={width}
            height="75"
            style={delay((index + 1) * 15)}
          />
        ))}
      </g>
    </svg>
  );
}
