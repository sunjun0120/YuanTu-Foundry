import { Fragment, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { gradients, paths } from './logo-data.ts';
import { mountLogoMotion } from './logo-motion.ts';

/** Reference Foundry mark: rise from behind the composer, split, then breathe. */
export function OrganicLogo(): ReactNode {
  const prefix = `organic-${useId().replace(/:/g, '')}`;
  const root = useRef<SVGSVGElement>(null);
  const lift = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (root.current && lift.current) return mountLogoMotion(root.current, lift.current);
  }, []);
  return (
    <span ref={lift} className="organic-lift" aria-hidden="true">
      <svg
        ref={root}
        className="organic-logo"
        width="66.43"
        height="66.43"
        viewBox="-7.78 -5.71 66.43 66.43"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        shapeRendering="geometricPrecision"
        data-motion-version="organic-rise"
      >
        <defs>
          {paths.map((path, index) => (
            <path key={index} id={`${prefix}-petal-${index}`} data-petal="" d={path.d} />
          ))}
          {gradients.map((gradient) => (
            <linearGradient
              key={gradient.id}
              id={`${prefix}-${gradient.id}`}
              data-material=""
              x1={gradient.x1}
              y1={gradient.y1}
              x2={gradient.x2}
              y2={gradient.y2}
              gradientUnits="userSpaceOnUse"
            >
              {gradient.stops.map((stop, index) => (
                <stop key={index} offset={stop.offset} stopColor={stop.color} />
              ))}
            </linearGradient>
          ))}
          <linearGradient
            id={`${prefix}-blob`}
            data-material=""
            x1="43"
            y1="11"
            x2="13"
            y2="47"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#b8eeff" />
            <stop offset=".28" stopColor="#8792ff" />
            <stop offset=".68" stopColor="#6265e9" />
            <stop offset="1" stopColor="#bca8fa" />
          </linearGradient>
          {paths.map((_, index) => (
            <Fragment key={index}>
              <radialGradient
                id={`${prefix}-light-${index}`}
                data-light={index}
                gradientUnits="userSpaceOnUse"
                cx="0"
                cy="0"
                r="1"
              >
                <stop stopColor="#fff" stopOpacity=".88" />
                <stop offset=".28" stopColor="#edf6ff" stopOpacity=".5" />
                <stop offset=".64" stopColor="#e0edff" stopOpacity=".12" />
                <stop offset="1" stopColor="#e0edff" stopOpacity="0" />
              </radialGradient>
              <radialGradient
                id={`${prefix}-shade-${index}`}
                data-shade={index}
                gradientUnits="userSpaceOnUse"
                cx="0"
                cy="0"
                r="1"
              >
                <stop stopColor="#34327c" stopOpacity=".18" />
                <stop offset="1" stopColor="#34327c" stopOpacity="0" />
              </radialGradient>
            </Fragment>
          ))}
          <filter
            id={`${prefix}-soft`}
            x="-25%"
            y="-25%"
            width="150%"
            height="150%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur stdDeviation=".2" />
          </filter>
        </defs>
        <g filter={`url(#${prefix}-soft)`} strokeLinejoin="round" strokeLinecap="round">
          {paths.map((path, index) => (
            <g key={index}>
              <use
                href={`#${prefix}-petal-${index}`}
                fill={`url(#${prefix}-blob)`}
                stroke={`url(#${prefix}-blob)`}
                strokeWidth=".9"
              />
              <use
                href={`#${prefix}-petal-${index}`}
                data-pigment={index}
                fill={`url(#${prefix}-${path.gradient})`}
                stroke={`url(#${prefix}-${path.gradient})`}
                strokeWidth=".9"
                opacity="0"
              />
              <use href={`#${prefix}-petal-${index}`} fill={`url(#${prefix}-shade-${index})`} />
              <use
                href={`#${prefix}-petal-${index}`}
                fill={`url(#${prefix}-light-${index})`}
                opacity=".58"
              />
            </g>
          ))}
        </g>
      </svg>
    </span>
  );
}
