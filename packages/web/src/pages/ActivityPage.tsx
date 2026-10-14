import { ActivityFeed } from '../components/ActivityFeed.js';
import { t } from '../i18n/index.js';

export function ActivityPage() {
  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <header className="page-header">
        <div>
          <h1>{t('activity.title')}</h1>
          <p className="subtitle">Every change by you, collaborators and Claude, with the tool it used. Any change can be reverted from the project history.</p>
        </div>
      </header>
      <ActivityFeed limit={200} filter />
    </div>
  );
}
