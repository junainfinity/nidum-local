// Nidum Local dashboard — user-facing strings in one place (spec §13, for later translation).
// Iteration 3 moved the strings of the sharing-state, risky-service, "taken", edit, Apply-strip and
// inline-error flows here; other views still carry their board copy inline.

export const T = {
  // Sharing state (E11, D29): one label per action.
  pauseSharing: 'Pause sharing',
  resumeSharing: 'Resume sharing', // after a deliberate pause
  startAgain: 'Start again', // after an unexpected stop (spec §7.14)
  waitingForPassword: 'Waiting for your password…',
  passwordNote: 'Your computer is asking for your password in a separate window.',
  stoppedBanner: 'Network sharing stopped. Your addresses are offline.',
  pausedBanner: 'Sharing is paused. Your addresses are offline until you resume.',
  pausedStrip: 'Sharing is paused. These addresses are offline.',
  offStrip: 'Sharing is off. These addresses are offline.',
  counterPaused: 'Sharing paused',
  counterOff: 'Sharing is off',
  needsAttention: 'Needs attention',

  // Risky services (spec §12).
  riskTitle: (addr) => ['Give ', addr, ' an address?'], // addr: an address vnode
  riskDocker: 'Anyone on this network could control Docker on this computer.',
  riskAdmin: (title) => `Anyone on this network could open ${title}, an admin page on this computer.`,
  riskTail: 'Only continue if you trust everyone on this network.',
  createAddress: 'Create address',

  // Names (spec §7.7).
  takenAlias: (name, port) => `${name} already points to port ${port}.`,
  takenApp: (name) => `${name} is used by a running app. Stop that app or pick another name.`,
  useAnotherName: 'Use another name',
  replaceIt: 'Replace it',

  // Inline editors in Your addresses.
  newPortFor: (host) => `New port for ${host}`,
  newNameFor: (host) => `New name for ${host}`,
  cancel: 'Cancel',
  save: 'Save',

  // Apply strip (E1 serviceReinstallNeeded).
  applyNotSetUp: 'Keep sharing after restart is on, but the startup service isn’t set up yet. Apply it now (needs your password).',
  applyRemove: 'Keep sharing after restart is off, but the startup service is still installed. Apply to remove it (needs your password).',
  applyOld: 'The startup service still uses your old settings. Apply them now (needs your password).',
  apply: 'Apply',
  applyFailed: 'Couldn’t apply the settings.',
  restartReason: 'Restart isn’t needed: the startup service runs sharing, and changed settings apply with Apply.',

  // Turning off "Keep sharing after restart" while the startup service runs sharing (graph validation 2 F1).
  keepOffTitle: 'Stop starting sharing automatically?',
  keepOffBody: 'Nidum Local will remove the startup service and keep sharing running until you restart this computer. Your computer may ask for your password twice.',
  turnOff: 'Turn off',
  // D45: while paused, removing the service keeps the pause and asks for one password.
  keepOffBodyPaused: 'Nidum Local will remove the startup service. Sharing stays paused until you resume it. Your computer will ask for your password.',
  serviceApplied: 'The startup service now uses your settings.',
  serviceRemoved: 'Sharing won’t start automatically any more.',
  // D50: installing the startup service while paused turns sharing back on, so ask first.
  applyResumeTitle: 'Apply and turn sharing back on?',
  applyResumeBody: 'Your addresses come back online.',
  // The same rule for turning "Keep sharing after restart" on while paused (it installs the service too).
  keepOnResumeTitle: 'Turn sharing back on?',
  keepOnResumeBody: 'Keep sharing after restart sets up the startup service, which turns sharing back on now. Your addresses come back online.',
  turnOn: 'Turn on',
  httpsOffNote: 'Camera, microphone and offline features won’t work on other devices.',

  // Inline errors (spec §11: never toasts).
  copyFailed: 'Couldn’t copy. Select the address and copy it yourself.',
  dismissFailed: 'Couldn’t hide this notice.',
  undoFailed: (host) => ['Couldn’t bring back ', host, '.'], // host: an address vnode
  tryAgain: 'Try again',
  dismiss: 'Dismiss',

  // Error rows (spec §8.3).
  rowBroken: ' isn’t working: ',
  rowRetryHint: (port) => `Check the app on port ${port}, then retry.`,
  retry: 'Retry',

  // Announcements (spec §13).
  newService: (port) => `New service on port ${port}.`,
  newServices: (ports) => `New services on ports ${ports.slice(0, -1).join(', ')} and ${ports[ports.length - 1]}.`,

  // Device setup tabs.
  deviceType: 'Device type',

  // Sections (design boards).
  discoverTitle: 'Discover',
  discoverDesc: 'Services running on this computer. Give any web service an address so other devices can open it.',
  addTitle: 'Add manually',
  addDesc: 'For services Discover can’t see, like a Docker container or something you’ll start later.',
  addressesTitle: 'Your addresses',
  addressesDesc: 'Everything other devices on your network can open right now.',
  sharingTitle: 'Network sharing',
  sharingDesc: 'Lets other devices on your network open your addresses.',
  toolsTitle: 'Tools',
  toolsDesc: 'Checks and fixes for when something isn’t reachable.',
  advancedTitle: 'Advanced',
  advancedDesc: 'Internet sharing and reset.',

  // Empty states (spec §8.1, §8.3).
  nothingRunning: 'Nothing is running yet.',
  nothingRunningText: 'Start your app, then come back. This list updates on its own.',
  addByPort: 'Add an address by port instead',
  onlySystem: 'Only system services are running.',
  showSystem: 'Show system services',
  noMatch: (q) => `No service matches “${q}”.`,
  clearSearch: 'Clear search',
  noAddresses: 'No addresses yet.',
  noAddressesText: 'Pick a service in Discover, or add one by port.',
  goToDiscover: 'Go to Discover',

  // Dialogs and toasts.
  removeBody: 'Devices using this address will stop reaching it. The service itself keeps running.',
  removeConfirm: 'Remove address',
  pauseTitle: 'Pause sharing?',
  // D43/E12: a startup service is paused too; it comes back on resume or at the next restart.
  pauseServiceBody: 'Your addresses go offline until you resume or restart this computer.',
  pauseBody: (n) => `${n === 1 ? '1 address' : `${n} addresses`} will go offline until you resume.`,
  // Failed sharing actions (page error banner): "Couldn't <words>."
  actionWords: { start: 'start sharing', resume: 'resume sharing', stop: 'pause sharing', restart: 'restart sharing' },
  couldnt: (words) => `Couldn't ${words || 'change sharing'}.`,
  sharingPausedToast: 'Sharing is paused. Your addresses are offline until you resume.',
  sharingOnToast: 'Sharing is on.',
  sharingRestartedToast: 'Sharing restarted.',

  // Reset Portless dialog: the server's list of what gets removed (GET /api/tools/clean).
  resetLoading: 'Checking what gets removed…',
  resetListFailed: 'Couldn’t load the list of what gets removed.',

  // Discover before the first port scan finishes (never "Nothing is running yet." then).
  scanning: 'Looking for services…',
  // Scans keep failing (no first scan after a while, or a forced scan came back without one).
  scanStuckTitle: 'Couldn’t look for services.',
  scanStuckText: 'Nidum Local keeps trying in the background. You can still add an address by port.',

  // E13 (D47, D48, D51): a locked or not-writable address list. Paths and commands arrive as vnodes
  // (addr.js PathText / CommandText), never as HTML.
  routesLockedReason: 'Your address list is locked.',
  routesNotWritableReason: "Nidum Local isn't allowed to change your address list.",
  checkAgain: 'Check again',
  routesStillBlocked: 'Nothing has changed yet.',
  // After Check again when the problem changed kind (locked → not writable, file → folder, …).
  routesStillBlockedOther: 'That changed something, but your address list is still blocked. The steps above are updated.',
  routesUnblocked: 'Your address list can be changed again.',
  // `hidden`: the item's name starts with "." and Finder hides it until Command-Shift-Period.
  fixFinder: (folder, item, strong, hidden) => ['In Finder, choose Go → Go to Folder…, enter ', folder,
    hidden ? ', press Command-Shift-Period (⌘⇧.) to show hidden items' : '', ', select ', item, ', choose File → Get Info, and uncheck ', strong('Locked'), '.'],
  fixOrTerminal: 'Or in Terminal:',
  fixSchgIntro: 'Only Terminal can clear this lock:',
  fixInTerminal: 'To fix it, run this in Terminal:',
  fixSudoNote: 'Terminal asks for this computer’s password.',
  notWritableYours: (what) => `This ${what}'s permissions don't allow changes.`,
  notWritableOwner: (what, owner) => `The ${what} belongs to another account (${owner}).`,
  notWritableUnknown: (what) => `This ${what} can't be changed by the account running Nidum Local.`,
  // The same, when the server doesn't say whether it is a file or a folder: name the item itself.
  notWritableYoursItem: (item) => ['The permissions on ', item, " don't allow changes."],
  notWritableOwnerItem: (item, owner) => [item, ` belongs to another account (${owner}).`],
  notWritableUnknownItem: (item) => [item, " can't be changed by the account running Nidum Local."],
  // D59(a): a uchg lock on another account's file or folder needs an administrator.
  lockedNotYours: (what, item, owner) => [what ? `The ${what}` : item, ` belongs to another account${owner ? ` (${owner})` : ''}, so only an administrator can unlock it.`],
  file: 'file',
  folder: 'folder',
  copyCommand: 'Copy',
  copyCommandLabel: (cmd) => `Copy the command ${cmd}`,
  commandCopied: 'Copied the command.',
  commandCopyFailed: 'Couldn’t copy. Select the command and copy it yourself.',

  quitTitle: 'Quit Nidum Local?',
  quitBody: 'Your addresses keep working; only this dashboard closes.',
  quit: 'Quit',
  ready: (ssid) => ` is ready. Open it on any device on ${ssid || 'your network'}.`,
  copied: (addr) => ['Copied ', addr],
  nowPointsTo: (addr, port) => [addr, ` now points to port ${port}.`],
  renamedTo: (addr) => ['Renamed to ', addr, '.'],
};
