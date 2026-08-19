/**
 * installgentoo.net: one mysqldump holding three boards (diy, g, sci) plus
 * the site's own administrative tables, and a second dump that is nothing but
 * those. Original Perl-Fuuka schema.
 *
 * The tarball is BZIP2 despite its .tar.xz name (magic BZh9), so `tar xJf`
 * fails and plain `tar xf` works.
 *
 * Which tables are boards is decided by the columns they declare, so
 * banlist/modlog/reports/staff/loginattempts drop out without being named.
 */

import { sh } from 'staging-core';
import { sqlNormalize } from 'staging-sql';

sh(
  'mkdir -p extracted && ls extracted/*.sql >/dev/null 2>&1 || ' +
    'tar xf source/installgentoo-mysql-2014-02-22.tar.xz -C extracted'
);

const { boards, files } = sqlNormalize({
  from: 'extracted',
  to: 'out',
  rename: 'fuuka',
});
console.log(`    ${boards} board file(s) from ${files} dump(s)`);
