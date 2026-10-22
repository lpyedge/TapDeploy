// A compact radio group rendered as a segmented control. The native radios stay
// in the DOM (visually hidden) so keyboard, screen readers and form semantics
// are unchanged.

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  testId?: string;
}

export function Segmented<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  name: string;
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled} className="seg" data-disabled={disabled}>
      {options.map((option) => (
        <label key={option.value} className="seg-opt">
          <input
            type="radio"
            className="absolute inset-0 m-0 size-full cursor-pointer opacity-0"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
            data-testid={option.testId}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}
