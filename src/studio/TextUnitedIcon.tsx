/**
 * "TU" mark for the TextUnited panel and action, so they are not confused with the translate
 * icon of Sanity's Document Internationalization plugin. Sized and coloured like @sanity/icons.
 */
export function TextUnitedIcon() {
  return (
    <svg
      data-sanity-icon="textunited"
      width="1em"
      height="1em"
      viewBox="0 0 25 25"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="4.5" y="5.5" width="16" height="14" rx="2.5" stroke="currentColor" strokeWidth={1.2} />
      <text
        x="12.5"
        y="15.6"
        textAnchor="middle"
        fontSize="8"
        fontWeight={700}
        fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
        fill="currentColor"
      >
        TU
      </text>
    </svg>
  )
}
