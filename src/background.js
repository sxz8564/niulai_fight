/*
 * The whole extension: click the toolbar button, get the game in a tab.
 *
 * A brawler in a 400-pixel popup is not a brawler, so there is no popup —
 * `action` without `default_popup` means the click reaches onClicked, and the
 * game opens where it has room to be played.
 *
 * The obvious refinement, focusing an already-open game instead of opening a
 * second one, is deliberately not here: matching tabs by URL needs the "tabs"
 * permission, which Chrome shows the user as "read your browsing history".
 * That is a real warning to accept in exchange for a small convenience in a
 * game, so the extension asks for no permissions at all instead.
 */
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});
