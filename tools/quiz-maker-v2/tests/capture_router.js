// Integrated: the router lines are in Code.gs and the harness loads every Phase2_*.gs next to it,
// so S3's tests just load Code.gs. (argv[3], the old Phase2_Capture.gs path, is ignored.)
module.exports = { buildCombined: codeGs => codeGs };
