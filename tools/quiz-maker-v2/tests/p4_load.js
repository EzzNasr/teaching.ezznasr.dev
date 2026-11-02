const fs = require('fs'), path = require('path'), vm = require('vm');
const { makeEnv } = require('./fixtures/phase2_env');
const APPS = path.join(__dirname, '..', 'apps_script');
const CODE = fs.readFileSync(path.join(APPS, 'Code.gs'), 'utf8');
function loadP4(api, names) {            // names e.g. ['Phase4_Scope.gs']
  names.forEach(n => {
    if (new RegExp('MERGED FROM ' + n.replace('.', '\\.')).test(CODE)) return;   // already merged into Code.gs
    const f = [path.join(APPS, 'chunks', n), path.join(APPS, n)].find(fs.existsSync);
    if (f) vm.runInContext(fs.readFileSync(f, 'utf8'), api.env.ctx, { filename: n });
  });
}
module.exports = { makeEnv, loadP4 };
