(function () {
  'use strict';

  function getCsrfToken() {
    var cookies = document.cookie.split('; ');
    for (var i = 0; i < cookies.length; i++) {
      var parts = cookies[i].split('=');
      if (parts[0] === 'csrf_token') {
        return decodeURIComponent(parts.slice(1).join('='));
      }
    }
    return '';
  }

  window.getCsrfToken = getCsrfToken;

  window.showToast = function (message, type) {
    var root = document.getElementById('toast-root');
    if (!root) { return; }
    var el = document.createElement('div');
    el.className = 'toast toast--' + (type || 'error');
    el.textContent = message;
    root.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('toast--visible'); });
    setTimeout(function () {
      el.classList.remove('toast--visible');
      setTimeout(function () { el.remove(); }, 300);
    }, 4500);
  };

  function updateThemeToggleButtons(theme) {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      var isLight = theme === 'light';
      btn.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
      btn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
      var sun = btn.querySelector('.icon-sun');
      var moon = btn.querySelector('.icon-moon');
      if (sun) { sun.hidden = isLight; }
      if (moon) { moon.hidden = !isLight; }
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest('[data-theme-toggle]');
    if (!btn) { return; }
    var html = document.documentElement;
    var next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    updateThemeToggleButtons(next);
  });

  function initNav() {
    var btn = document.getElementById('nav-toggle-btn');
    var nav = document.getElementById('topbar-nav');
    if (!btn || !nav) { return; }

    var mediaQuery = window.matchMedia('(max-width: 640px)');

    function setNavOpen(open) {
      nav.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.classList.toggle('nav-toggle--open', open);
      if (mediaQuery.matches) {
        nav.hidden = !open;
      } else {
        nav.hidden = false;
      }
    }

    function syncForViewport() {
      if (mediaQuery.matches) {
        setNavOpen(false);
      } else {
        nav.hidden = false;
        nav.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        btn.classList.remove('nav-toggle--open');
      }
    }

    btn.addEventListener('click', function () {
      setNavOpen(!nav.classList.contains('open'));
    });

    nav.addEventListener('click', function (event) {
      if (!mediaQuery.matches) { return; }
      if (event.target && event.target.closest('.nav-link')) {
        setNavOpen(false);
      }
    });

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', syncForViewport);
    } else {
      mediaQuery.addListener(syncForViewport);
    }

    syncForViewport();
  }

  function initCsrfForms() {
    var SELF_MANAGED = { 'upload-form': true, 'resumable-form': true, 'content-upload-form': true };

    function handleFormSubmit(e) {
      if (e.defaultPrevented) { return; }
      var form = e.currentTarget;
      if (SELF_MANAGED[form.id]) { return; }

      e.preventDefault();
      var action = form.action || window.location.href;
      var enctype = (form.getAttribute('enctype') || '').toLowerCase();
      var headers = { 'X-CSRF-Token': getCsrfToken() };
      var body;

      if (enctype === 'multipart/form-data') {
        body = new FormData(form);
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(new FormData(form)).toString();
      }

      fetch(action, {
        method: 'POST',
        headers: headers,
        body: body,
        credentials: 'same-origin'
      }).then(function (res) {
        if (res.redirected) {
          window.location.href = res.url;
        } else if (res.ok) {
          window.location.reload();
        } else {
          return res.text().then(function (text) {
            var msg = 'Request failed (' + res.status + ')';
            try { var j = JSON.parse(text); if (j.error) { msg = j.error; } } catch (ignored) {}
            window.showToast(msg, 'error');
          });
        }
      }).catch(function () {
        window.showToast('Network error. Please try again.', 'error');
      });
    }

    document.querySelectorAll('form[method="post"], form[method="POST"]').forEach(function (form) {
      form.addEventListener('submit', handleFormSubmit);
    });
  }

  function initSegmentedFilters() {
    var root = document.getElementById('library-segmented');
    if (!root) { return; }
    var sections = document.querySelectorAll('[data-library-section]');
    root.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-filter]');
      if (!btn) { return; }
      var filter = btn.getAttribute('data-filter');
      root.querySelectorAll('[data-filter]').forEach(function (b) {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });
      sections.forEach(function (section) {
        var type = section.getAttribute('data-library-section');
        var show = filter === 'all' || filter === type;
        section.hidden = !show;
      });
    });
  }

  function initViewAll() {
    var btn = document.getElementById('view-all-videos-btn');
    var rest = document.getElementById('videos-list-rest');
    var row = document.getElementById('view-all-videos-row');
    if (!btn || !rest) { return; }
    btn.addEventListener('click', function () {
      rest.classList.remove('video-list--hidden');
      if (row) { row.style.display = 'none'; }
    });
  }

  function initOverflowMenus() {
    document.addEventListener('click', function (e) {
      var toggle = e.target.closest('[data-overflow-toggle]');
      if (toggle) {
        e.stopPropagation();
        var menu = toggle.parentElement.querySelector('.overflow-menu');
        var open = menu && !menu.classList.contains('open');
        document.querySelectorAll('.overflow-menu.open').forEach(function (m) { m.classList.remove('open'); });
        if (menu && open) { menu.classList.add('open'); }
        return;
      }
      if (!e.target.closest('.overflow-menu-wrap')) {
        document.querySelectorAll('.overflow-menu.open').forEach(function (m) { m.classList.remove('open'); });
      }
    });
  }

  function initFilterDrawer() {
    var toggle = document.getElementById('admin-filter-toggle');
    var drawer = document.getElementById('admin-filter-drawer');
    if (!toggle || !drawer) { return; }
    toggle.addEventListener('click', function () {
      var open = drawer.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    updateThemeToggleButtons(document.documentElement.getAttribute('data-theme') || 'dark');
    initNav();
    initCsrfForms();
    initSegmentedFilters();
    initViewAll();
    initOverflowMenus();
    initFilterDrawer();
  });
})();
