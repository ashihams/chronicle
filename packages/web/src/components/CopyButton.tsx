import { useState } from 'react';
import { copyText } from '../format';

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }): React.ReactElement {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost !min-h-0 !px-2 !py-1 font-mono text-[11px] tracking-wide"
      onClick={() => {
        void copyText(value).then((done) => {
          setOk(done);
          if (done) window.setTimeout(() => setOk(false), 1500);
        });
      }}
    >
      {ok ? 'Copied' : label}
    </button>
  );
}
