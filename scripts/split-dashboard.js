const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../src/views/admin/dashboard.ejs'), 'utf8');
const tabs = ['users', 'upload', 'videos', 'courses', 'monitor'];
const dir = path.join(__dirname, '../src/views/admin/partials');
fs.mkdirSync(dir, { recursive: true });

for (const tab of tabs) {
  const start = `<% if (activeTab === '${tab}') { %>`;
  const startIdx = src.indexOf(start);
  if (startIdx < 0) {
    console.error('missing tab', tab);
    continue;
  }
  let endIdx = src.length;
  for (const other of tabs) {
    if (other === tab) continue;
    const otherStart = src.indexOf(`<% if (activeTab === '${other}') { %>`, startIdx + start.length);
    if (otherStart >= 0 && otherStart < endIdx) {
      endIdx = otherStart;
    }
  }
  const monitorEnd = src.indexOf('<%- include(\'../partials/foot.ejs\') %>', startIdx);
  if (tab === 'monitor' && monitorEnd >= 0) {
    endIdx = monitorEnd;
  }
  const body = src.slice(startIdx + start.length, endIdx).trim();
  const cleaned = body.replace(/\n<%\s*}\s*%>\s*$/m, '');
  fs.writeFileSync(path.join(dir, `tab-${tab}.ejs`), cleaned);
}

const shell = `<%- include('../partials/head.ejs', { title: 'Admin Dashboard', user, loadAdminJs: true }) %>
<section class="card admin-tabs admin-tabs--scroll">
  <a class="tab-link <%= activeTab === 'users' ? 'active' : '' %>" href="/admin?tab=users">Users</a>
  <a class="tab-link <%= activeTab === 'upload' ? 'active' : '' %>" href="/admin?tab=upload">Upload</a>
  <a class="tab-link <%= activeTab === 'videos' ? 'active' : '' %>" href="/admin?tab=videos">Content</a>
  <a class="tab-link <%= activeTab === 'courses' ? 'active' : '' %>" href="/admin?tab=courses">Courses</a>
  <a class="tab-link <%= activeTab === 'monitor' ? 'active' : '' %>" href="/admin?tab=monitor">Monitor</a>
</section>
<% if (activeTab === 'users') { %><%- include('partials/tab-users.ejs') %><% } %>
<% if (activeTab === 'upload') { %><%- include('partials/tab-upload.ejs') %><% } %>
<% if (activeTab === 'videos') { %><%- include('partials/tab-videos.ejs') %><% } %>
<% if (activeTab === 'courses') { %><%- include('partials/tab-courses.ejs') %><% } %>
<% if (activeTab === 'monitor') { %><%- include('partials/tab-monitor.ejs') %><% } %>
<%- include('../partials/foot.ejs') %>
`;

fs.writeFileSync(path.join(__dirname, '../src/views/admin/dashboard.ejs'), shell);
console.log('done', tabs.map((t) => fs.statSync(path.join(dir, `tab-${t}.ejs`)).size));
