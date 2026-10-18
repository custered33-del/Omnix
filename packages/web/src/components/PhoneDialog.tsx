import { useEffect, useMemo, useState } from 'react';
import { Smartphone } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { get } from '../lib/api.js';
import { Dialog, Spinner } from '../ui/primitives.js';
import { CopyField } from '../pages/SetupGuide.js';

interface Info {
  publicUrl: string;
  local: boolean;
  https: boolean;
  lanUrls?: string[];
}

const isLocal = (host: string) => /^(localhost|127\.|\[?::1\]?$)/.test(host);

/** Where a phone can open this Omnix: the internet link if there is one, else this computer on the home Wi-Fi. */
export function phoneLink(info: Info | null, here: Location = window.location): { url: string; anywhere: boolean } | null {
  if (!isLocal(here.hostname)) return { url: here.origin, anywhere: here.protocol === 'https:' };
  if (info && info.https && !info.local) return { url: info.publicUrl, anywhere: true };
  const lan = info?.lanUrls?.[0];
  return lan ? { url: lan, anywhere: false } : null;
}

/** A QR code as crisp SVG squares, always dark on white so every phone camera reads it. */
export function QrCode({ text, size = 220, label }: { text: string; size?: number; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const rects: string[] = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) rects.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    return { n: n + 8, d: rects.join('') };
  }, [text]);
  return (
    <svg className="qr" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${cells.n} ${cells.n}`} shapeRendering="crispEdges">
      <rect width={cells.n} height={cells.n} fill="#ffffff" />
      <path d={cells.d} fill="#000000" />
    </svg>
  );
}

export function PhoneDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    get<Info>('/api/claude/setup-info').then(setInfo, () => setFailed(true));
  }, []);
  const link = phoneLink(info);
  return (
    <Dialog title="Open Omnix on your phone" icon={<Smartphone />} onClose={onClose}>
      {!info && !failed && <Spinner />}
      {(info || failed) && !link && (
        <p className="notice warning">This computer has no address a phone can reach. Start Omnix with Omnix-PC.bat, then open this again.</p>
      )}
      {link && (
        <div className="phone-link">
          <QrCode text={link.url} label={`QR code for ${link.url}`} />
          <ol className="gpt-steps">
            <li>Open the camera on your phone and point it at the code.</li>
            <li>Tap the link that pops up.</li>
            <li>Sign in with the same email and password as here.</li>
          </ol>
          <p className="muted">
            {link.anywhere
              ? 'This works anywhere, even on mobile data, while Omnix is running on this computer. The link changes each time Omnix starts, so scan again after a restart.'
              : 'Your phone must be on the same Wi-Fi as this computer. If Windows asks whether to allow Node.js on the network, click Allow.'}
          </p>
          <CopyField label="Or type this link on your phone" value={link.url} />
        </div>
      )}
    </Dialog>
  );
}
