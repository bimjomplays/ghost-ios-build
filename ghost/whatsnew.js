// What's New: the text of the one-time screen Ghost shows on the first open after an update (ui.js, section
// "What's New"). Written at publish time, one entry per released version (the key is the exact
// CFBundleShortVersionString from ios/project.yml). A version without an entry shows nothing.
//
// Rules for the text (it is read by friends, not developers):
//   - 2 to 5 short bullets, plain words, what the person can now do or what got better. Start with the feature.
//   - `how` is optional: where to find it, one line ("Settings > Report a Bug or Idea"). Only when it needs it.
//   - No ticket numbers, test counts, file or function names, protocol terms.
//   - If a build ships several versions at once (e.g. 1.15.0 inside 1.16.0), put the bullets of all of them
//     in the newest entry.
window.GHOST_WHATS_NEW = {
  "1.19.9": {
    items: [
      { t: "Midnight Glass adds floating chat controls, a roomy two-row composer and Telegram-style bubbles. Your current theme stays the same.", how: "Settings > Appearance > Midnight Glass" },
      { t: "Your message time setting, pinned messages, read indicators and Ghost contact badges still work with the new look." },
      { t: "TikTok messaging uses matching Midnight Glass materials without changing its controls." },
    ],
  },
  "1.19.8": {
    items: [
      { t: "Midnight Glass adds softly frosted controls to the Ghost you know. It's optional; your current look stays the same.", how: "Settings > Appearance > Midnight Glass" },
      { t: "Feedback now explains that reports and pictures are saved for review. Received doesn't mean work has started." },
    ],
  },
  "1.19.7": {
    items: [
      { t: "Chats that have messages no longer open on \"No messages yet\": Ghost retries by itself and offers a Retry button." },
    ],
  },
  "1.19.6": {
    items: [
      { t: "Ghost desktop: chats open again on PCs where a graphics driver update left the chat pane blank." },
      { t: "Ghost desktop restarts its page by itself if it freezes, instead of hanging the window." },
    ],
  },
  "1.19.5": {
    items: [
      { t: "Pinned chats now show a new message in the chat list, instead of an old one that looked already opened." },
    ],
  },
  "1.19.4": {
    items: [
      { t: "Holding a message to react no longer pops up the magnifying glass over the reaction bar." },
      { t: "The \"using Snapchat for Web\" line in a chat shows up again." },
      { t: "Snaps that only open in the Snapchat app now show a plain \"Phone only\" tile. The \"Open in Snapchat\" button is gone." },
    ],
  },
  "1.19.3": {
    items: [
      { t: "Use Ghost on your PC too: Ghost desktop becomes this same Ghost, with your Ghost friends and chats.", how: "Settings > Privacy > Link Ghost Desktop" },
      { t: "Before linking, check that your PC shows the same Ghost ID as your phone, every group." },
      { t: "A snap that won't load can now be marked opened, so it stops showing as new. Long-press any unopened snap for Mark as Opened or Mark as New." },
    ],
  },
  "1.19.2": {
    items: [
      { t: "Snaps that only open in the Snapchat app now say \"Open in Snapchat\" right away, and a tap opens the Snapchat app." },
      { t: "Mark one of those snaps as opened to clear it from your chat list. It stays new in Snapchat.", how: "Chat > Mark opened, or long-press the snap" },
      { t: "8 Ball matches no longer get stuck after a few shots. Your friend needs this update too." },
    ],
  },
  "1.19.1": {
    items: [
      { t: "A friend's story video with a caption plays as one snap again, with the caption on the video." },
      { t: "Snaps that didn't open the first time try again, and if one still won't load, a tap on it tries once more." },
      { t: "Game moves, friends' Ghost changes and answers to your bug reports now show up the moment they're sent while Ghost is open." },
      { t: "The snap camera no longer stays black, typing a caption no longer squeezes your photo, and you can paste a picture into a chat to send it.", how: "Chat > message box > Paste" },
      { t: "A copied picture or screenshot (even after Copy and Delete) can be sent with the new Paste button in the photo picker.", how: "Chat > Gallery > Paste" },
    ],
  },
  "1.19.0": {
    items: [
      { t: "Game moves, friends' Ghost changes and answers to your bug reports now show up the moment they're sent while Ghost is open." },
      { t: "Ghost keeps one quiet connection open instead of checking every few seconds, so it stays reliable on a busy home network." },
      { t: "The snap camera no longer stays black: Ghost restarts it, and if that fails it says so and a tap tries again." },
      { t: "Typing a caption no longer squeezes your photo: it stays full-screen and the caption moves up above the keyboard while you type." },
      { t: "Copy a picture anywhere and paste it into a chat's message box to send it.", how: "Chat > message box > Paste" },
    ],
  },
  "1.18.3": {
    items: [
      { t: "The snap camera no longer stays black: Ghost restarts it, and if that fails it says so and a tap tries again." },
      { t: "Typing a caption no longer squeezes your photo: it stays full-screen and the caption moves up above the keyboard while you type." },
      { t: "Copy a picture anywhere and paste it into a chat's message box to send it.", how: "Chat > message box > Paste" },
    ],
  },
  "1.18.2": {
    items: [
      { t: "With an Apple developer account, notifications while Ghost is closed can come straight to Ghost instead of the ntfy app.", how: "Settings > Notifications > Apple Push" },
      { t: "Tapping one of those notifications opens the chat, and opening a chat clears its notifications." },
      { t: "After each update you now see a short note like this one, once, with what changed." },
      { t: "Bug reports that had to wait now really go out, even after you close Ghost, and show if they're waiting, sending or sent.", how: "Settings > Report a Bug or Idea" },
      { t: "The report form is simpler and big pictures are made a bit smaller so reports with several of them go through." },
      { t: "Ghost checks for new messages less often when idle, so it stays reliable on a busy network." },
    ],
  },
  "1.18.1": {
    items: [
      { t: "After each update you now see a short note like this one, once, with what changed." },
      { t: "Bug reports that had to wait now really go out, even after you close Ghost, and show if they're waiting, sending or sent.", how: "Settings > Report a Bug or Idea" },
      { t: "Reports with several pictures go through: big pictures are made a bit smaller so they fit." },
      { t: "The report form is simpler: just your text and pictures, no Screen field to fill in." },
      { t: "Ghost checks for new messages less often when idle, so it stays reliable on a busy network." },
    ],
  },
  "1.18.0": {
    items: [
      { t: "After each update you now see a short note like this one, once, with what changed." },
      { t: "Bug reports send reliably: if the server is busy, Ghost keeps the report and sends it by itself a little later." },
      { t: "Reports with several pictures go through: big pictures are made a bit smaller so they fit." },
      { t: "The report form is simpler: just your text and pictures, no Screen field to fill in." },
      { t: "Ghost checks for new messages less often when idle, so it stays reliable on a busy network." },
    ],
  },
};
