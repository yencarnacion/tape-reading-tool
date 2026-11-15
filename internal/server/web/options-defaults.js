// Subscription-aware startup/reset defaults. Gexbot has a separate subscription.
export function applyOptionsDefaults(settings, enabled) {
  if (enabled === true) return settings;
  settings.showGEXOverlay = false;
  const panels = settings.panels;
  const lower = panels.slots.lowerAnalytics;
  if (['options-flow', 'estimated-gex'].includes(lower.activePanelId)) lower.activePanelId = 'tick-chart';
  panels.settings['adr-rth-extension'] = {...panels.settings['adr-rth-extension'], showOptionsContext:false};
  return settings;
}
