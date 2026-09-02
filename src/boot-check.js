/*
 * Says what went wrong when the game does not start.
 *
 * The failure this exists for: the bundle is a build artifact, and if it is
 * missing the browser reports net::ERR_FILE_NOT_FOUND to a console nobody has
 * open and the page sits on LOADING for ever. That is a bad way to find out
 * you needed to run a build.
 *
 * A separate classic script rather than an inline one on purpose: an
 * extension page's content security policy forbids inline script, so a
 * diagnostic written inline would itself be the thing that silently does not
 * run.
 */
(function () {
  var loading = document.getElementById('loading');
  if (!loading) return;

  function explain(title, lines) {
    loading.innerHTML = '';
    var box = document.createElement('div');
    box.style.cssText = 'max-width:38em;line-height:1.7;text-align:left;padding:24px';
    var heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'color:#ffd76a;font-size:17px;margin-bottom:14px;letter-spacing:.06em';
    box.appendChild(heading);
    for (var i = 0; i < lines.length; i++) {
      var line = document.createElement('div');
      line.textContent = lines[i];
      line.style.cssText = 'color:#c9d1d9;font-size:13px;margin:6px 0';
      box.appendChild(line);
    }
    loading.appendChild(box);
    loading.hidden = false;
  }

  // Opening index.html by double-clicking it cannot work: a module script and
  // every fetch of a model are both refused over file://.
  if (location.protocol === 'file:') {
    explain('This cannot run from a file:// URL', [
      'Modules and asset loading are both blocked when a page is opened directly.',
      '',
      'Load it as an extension:  chrome://extensions → Developer mode → Load unpacked',
      'Or serve it:  npm run serve'
    ]);
    return;
  }

  // Give the models a generous while — they are a megabyte each and a cold
  // start on a slow machine is not a failure.
  setTimeout(function () {
    if (globalThis.__niulaiFight) return;

    fetch('dist/bundle.js', { method: 'HEAD' })
      .then(function (response) {
        if (response.ok) {
          explain('The game did not start', [
            'The bundle loaded but the game never came up.',
            'Open the console (F12) — an error there will say why.'
          ]);
        } else {
          missingBundle();
        }
      })
      .catch(missingBundle);
  }, 12000);

  function missingBundle() {
    explain('dist/bundle.js is missing', [
      'The game is bundled from source and the bundle is not checked in on every',
      'branch. Build it once:',
      '',
      '    npm install',
      '    npm run build',
      '',
      'Then reload the extension at chrome://extensions.'
    ]);
  }
})();
