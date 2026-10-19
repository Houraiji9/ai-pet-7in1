'use strict';
const $ = (id) => document.getElementById(id);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
$('hide').onclick = () => window.assetsProgress.hide();
$('retry').onclick = () => window.assetsProgress.retry();
window.assetsProgress.onUpdate((s) => {
  $('fill').style.width = s.percent + '%';
  $('retry').style.display = s.state === 'offline' || s.state === 'partial' ? 'inline-block' : 'none';
  if (s.state === 'downloading') {
    $('title').textContent = `正在下载动画资源 ${s.percent}%`;
    $('sub').textContent = `${s.roleText || ''} ${s.doneFiles}/${s.totalFiles} 个，${mb(s.doneBytes)} / ${mb(s.totalBytes)}`;
  } else if (s.state === 'checking') {
    $('title').textContent = '正在检查动画资源…';
  } else if (s.state === 'done') {
    $('title').textContent = '动画资源下载完成';
    $('sub').textContent = '所有角色的动作都可以用了';
  } else if (s.state === 'partial') {
    $('title').textContent = `动画资源下载了 ${s.percent}%`;
    $('sub').textContent = s.error || '有些文件没下成功，稍后会自动重试';
  } else if (s.state === 'offline') {
    $('title').textContent = '暂时连不上 GitHub';
    $('sub').textContent = '先用已有的动画，联网后会自动继续下载';
  }
});
