(function () {
  'use strict';

  function initResetPasswordModal() {
    var modal = document.getElementById('reset-password-modal');
    var form = document.getElementById('reset-password-form');
    var closeBtn = document.getElementById('close-reset-modal');
    if (!modal || !form) { return; }

    var emailText = document.getElementById('reset-user-email');
    var passwordInput = document.getElementById('reset-password-input');
    var confirmInput = document.getElementById('reset-password-confirm');
    var errorText = document.getElementById('reset-password-error');

    function closeModal() {
      modal.style.display = 'none';
      form.action = '';
      form.reset();
      if (errorText) { errorText.style.display = 'none'; }
    }

    document.querySelectorAll('.open-reset-modal').forEach(function (btn) {
      btn.addEventListener('click', function () {
        form.action = '/admin/users/' + btn.getAttribute('data-user-id') + '/reset-password';
        if (emailText) { emailText.textContent = 'User: ' + btn.getAttribute('data-user-email'); }
        modal.style.display = 'flex';
      });
    });

    if (closeBtn) { closeBtn.addEventListener('click', closeModal); }
    modal.addEventListener('click', function (e) { if (e.target === modal) { closeModal(); } });
    form.addEventListener('submit', function (e) {
      if (passwordInput.value !== confirmInput.value) {
        e.preventDefault();
        if (errorText) { errorText.style.display = 'block'; }
      }
    });
  }

  function initVideoOrderTouchButtons() {
    var list = document.getElementById('video-order-list');
    if (!list || window.matchMedia('(hover: hover)').matches) { return; }

    list.querySelectorAll('li').forEach(function (li) {
      li.setAttribute('draggable', 'false');
      var actions = document.createElement('div');
      actions.className = 'video-order-actions';
      actions.innerHTML = '<button type="button" class="linkish-btn" data-move="up">↑</button><button type="button" class="linkish-btn" data-move="down">↓</button>';
      li.appendChild(actions);
    });

    list.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-move]');
      if (!btn) { return; }
      var li = btn.closest('li');
      if (!li) { return; }
      if (btn.getAttribute('data-move') === 'up' && li.previousElementSibling) {
        list.insertBefore(li, li.previousElementSibling);
      }
      if (btn.getAttribute('data-move') === 'down' && li.nextElementSibling) {
        list.insertBefore(li.nextElementSibling, li);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initResetPasswordModal();
    initVideoOrderTouchButtons();
  });
})();
