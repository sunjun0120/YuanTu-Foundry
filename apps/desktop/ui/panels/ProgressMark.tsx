/** A progress box; panels supply a localized label when the icon is the only status cue. */
export function ProgressMark({
  completed = false,
  label,
}: {
  completed?: boolean;
  label?: string;
}) {
  return (
    <svg
      className="progress-mark"
      viewBox="0 0 14 14"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      <rect x="1" y="1" width="12" height="12" rx="3.5" />
      {completed ? <path d="m3.5 7.5 2.5 2.5 4.5-5.5" /> : null}
    </svg>
  );
}
