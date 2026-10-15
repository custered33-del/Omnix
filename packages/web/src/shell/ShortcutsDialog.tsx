import { useCommandStore } from '../state/commands.js';
import { Dialog } from '../ui/primitives.js';
import { formatShortcut } from '../ui/shortcuts.js';
import { t, type MessageKey } from '../i18n/index.js';

const GROUPS: { title: MessageKey; items: [string, MessageKey][] }[] = [
  {
    title: 'shortcuts.general',
    items: [
      ['mod+k', 'shortcuts.palette'],
      ['shift+?', 'shortcuts.help'],
      ['mod+z', 'shortcuts.undo'],
      ['mod+shift+z', 'shortcuts.redo'],
      ['mod+s', 'shortcuts.save'],
    ],
  },
  {
    title: 'shortcuts.editing',
    items: [
      ['del', 'shortcuts.delete'],
      ['mod+d', 'shortcuts.duplicate'],
      ['mod+a', 'shortcuts.selectAll'],
      ['esc', 'shortcuts.deselect'],
      ['arrows', 'shortcuts.nudge'],
    ],
  },
  {
    title: 'shortcuts.image',
    items: [
      ['v', 'image.tools.move'],
      ['m', 'image.tools.marquee'],
      ['l', 'image.tools.lasso'],
      ['w', 'image.tools.wand'],
      ['b', 'image.tools.brush'],
      ['e', 'image.tools.eraser'],
      ['s', 'image.tools.clone'],
      ['j', 'image.tools.heal'],
      ['t', 'image.tools.text'],
      ['u', 'image.tools.shape'],
      ['i', 'image.tools.eyedropper'],
      ['mod+=', 'shortcuts.zoomIn'],
      ['mod+-', 'shortcuts.zoomOut'],
      ['mod+0', 'shortcuts.zoomFit'],
    ],
  },
  {
    title: 'shortcuts.video',
    items: [
      ['space', 'shortcuts.playPause'],
      ['mod+b', 'shortcuts.split'],
      ['→', 'shortcuts.frameNext'],
      ['←', 'shortcuts.framePrev'],
    ],
  },
  {
    title: 'shortcuts.code',
    items: [
      ['mod+enter', 'shortcuts.runFile'],
      ['shift+enter', 'shortcuts.run'],
      ['esc-tab', 'shortcuts.leaveCode'],
    ],
  },
];

export function ShortcutsDialog() {
  const open = useCommandStore((s) => s.shortcutsOpen);
  const setOpen = useCommandStore((s) => s.openShortcuts);
  if (!open) return null;
  return (
    <Dialog title={t('shortcuts.title')} onClose={() => setOpen(false)} wide>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 24 }}>
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="section-title" style={{ marginBottom: 8 }}>
              {t(g.title)}
            </h3>
            <dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}>
              {g.items.map(([k, label]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt style={{ color: 'var(--text)' }}>{t(label)}</dt>
                  <dd>
                    <kbd>{k === 'arrows' ? '← ↑ → ↓' : k === 'esc-tab' ? t('shortcuts.escThenTab') : formatShortcut(k)}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
