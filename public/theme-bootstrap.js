(function () {
  try {
    var theme = localStorage.getItem('qbackup.theme') || 'dark';
    document.documentElement.classList.toggle('dark', theme === 'dark');
  } catch (_) {
    document.documentElement.classList.add('dark');
  }
})();
