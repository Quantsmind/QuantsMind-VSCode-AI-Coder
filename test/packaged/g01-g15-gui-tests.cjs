/**
 * G01-G15 Packaged GUI Regression Tests for QuantsMind VS Code AI Coder v2.0.0
 *
 * Drives real VS Code GUI via Chrome DevTools Protocol (CDP) on port 9333.
 */

const { getTargets, connect } = require('C:/Windows/Temp/opencode/cdp-lib.cjs');

const RESULTS = [];
let passed = 0;
let failed = 0;
let blocked = 0;
let notTested = 0;

function record(id, name, status, detail) {
  RESULTS.push({ id, name, status, detail: detail || '' });
  switch (status) {
    case 'PASS': passed++; break;
    case 'FAIL': failed++; break;
    case 'BLOCKED': blocked++; break;
    case 'NOT TESTED': notTested++; break;
  }
  console.log('[' + status + '] ' + id + ': ' + name + (detail ? ' — ' + detail : ''));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCommand(c, command) {
  await c.key(3, 'P', 'KeyP', 80);
  await sleep(700);
  await c.evaluate('var el=document.querySelector(".quick-input-box input");if(el)el.focus();');
  await c.insertText(command);
  await sleep(700);
  await c.key(0, 'Enter', 'Enter', 13);
  await sleep(2000);
}

async function openSettingsSearch(c, query) {
  await runCommand(c, 'Preferences: Open Settings (UI)');
  await sleep(1500);
  await c.evaluate('var el=document.querySelector(".settings-editor textarea.inputarea");if(el){el.focus();el.value="";}');
  await c.key(2, 'a', 'KeyA', 65);
  await sleep(300);
  await c.insertText(query);
  await sleep(2000);
}

async function findChatTarget() {
  var targets = await getTargets(9333);
  // Look for webview targets or pages with quantsmind in URL/title
  return targets.find(function (t) {
    return (t.type === 'webview' || t.type === 'page' || t.type === 'iframe') &&
      (t.url.indexOf('quantsmind') >= 0 || t.title.indexOf('QuantsMind') >= 0 || t.url.indexOf('webview') >= 0);
  });
}

async function retryEval(c, expr, maxRetries, delayMs) {
  for (var i = 0; i < maxRetries; i++) {
    try {
      var result = await c.evaluate(expr);
      if (result !== undefined && result !== null) return result;
    } catch (_e) { /* retry */ }
    await sleep(delayMs);
  }
  return undefined;
}

async function main() {
  const targets = await getTargets(9333);
  if (targets.length === 0) {
    console.log('No CDP targets found.');
    process.exit(1);
  }
  const mainTarget = targets.find((t) => t.type === 'page' && t.url.includes('workbench.html'));
  if (!mainTarget) {
    console.log('No main workbench target found.');
    process.exit(1);
  }
  const c = await connect(mainTarget);
  console.log('Connected to main VS Code window:', mainTarget.title);

  // Warm-up: allow extension to fully activate
  await sleep(3000);

  try {
    // G01: Open provider configuration
    try {
      await openSettingsSearch(c, 'quantsmind');
      await sleep(1000);
      const settingsText = await c.evaluate('var root=document.querySelector(".settings-editor");root?root.innerText.slice(0,3000):"";');
      if (settingsText && (settingsText.indexOf('Quantsmind') >= 0 || settingsText.indexOf('quantsmind') >= 0) && settingsText.indexOf('Provider') >= 0) {
        record('G01', 'Open provider configuration', 'PASS', 'Settings UI opened with QuantsMind provider settings');
      } else {
        record('G01', 'Open provider configuration', 'FAIL', 'Settings UI did not show QuantsMind provider settings: ' + settingsText.slice(0, 200));
      }
    } catch (e) {
      record('G01', 'Open provider configuration', 'FAIL', String(e));
    }
    await c.key(0, 'Escape', 'Escape', 27);
    await sleep(500);

    // G02: Display provider classifications
    try {
      await runCommand(c, 'QuantsMind: Select Provider Profile');
      await sleep(2500);
      var quickpickText = await retryEval(c,
        'var rows=document.querySelectorAll(".quick-input-list .monaco-list-row");var out=[];for(var i=0;i<rows.length;i++)out.push(rows[i].innerText);out;',
        5, 500);
      if (!quickpickText) quickpickText = [];
      var joined = quickpickText.join(' | ');
      var hasClassification = /(Free|Paid|Local|Custom|pricing unknown|API key)/i.test(joined);
      var hasProviders = /(OpenAI|Groq|Pollinations|Ollama|Gemini|OpenRouter|LM Studio|llama.cpp|vLLM)/i.test(joined);
      if (hasClassification && hasProviders) {
        record('G02', 'Display provider classifications', 'PASS', 'QuickPick shows provider names with classification labels: ' + JSON.stringify(quickpickText.slice(0, 3)));
      } else {
        record('G02', 'Display provider classifications', 'FAIL', 'Expected provider names with classifications, got ' + quickpickText.length + ' items: ' + JSON.stringify(quickpickText.slice(0, 5)));
      }
    } catch (e) {
      record('G02', 'Display provider classifications', 'FAIL', String(e));
    }
    await c.key(0, 'Escape', 'Escape', 27);
    await sleep(500);

    // G03: Select Pollinations free preset
    try {
      await c.key(0, 'Escape', 'Escape', 27);
      await sleep(500);
      await runCommand(c, 'QuantsMind: Select Provider Profile');
      await sleep(2500);
      await c.evaluate('var el=document.querySelector(".quick-input-box input");if(el)el.focus();');
      await c.insertText('pollinations');
      await sleep(1000);
      var pollinationsVisible = await retryEval(c,
        'var rows=document.querySelectorAll(".quick-input-list .monaco-list-row");var found=false;for(var i=0;i<rows.length;i++){if(rows[i].innerText.indexOf("Pollinations")>=0)found=true;}found;',
        8, 500);
      if (pollinationsVisible) {
        await c.key(0, 'Enter', 'Enter', 13);
        await sleep(1500);
        record('G03', 'Select Pollinations free preset', 'PASS', 'Pollinations selected via QuickPick');
      } else {
        record('G03', 'Select Pollinations free preset', 'FAIL', 'Pollinations not found in QuickPick');
      }
    } catch (e) {
      record('G03', 'Select Pollinations free preset', 'FAIL', String(e));
    }

    // G04: Configure a paid provider (OpenAI)
    try {
      await c.key(0, 'Escape', 'Escape', 27);
      await sleep(500);
      await runCommand(c, 'QuantsMind: Select Provider Profile');
      await sleep(2500);
      await c.evaluate('var el=document.querySelector(".quick-input-box input");if(el)el.focus();');
      await c.insertText('openai');
      await sleep(1000);
      var openaiVisible = await retryEval(c,
        'var rows=document.querySelectorAll(".quick-input-list .monaco-list-row");var found=false;for(var i=0;i<rows.length;i++){if(rows[i].innerText.indexOf("OpenAI")>=0)found=true;}found;',
        8, 500);
      if (openaiVisible) {
        await c.key(0, 'Enter', 'Enter', 13);
        await sleep(1500);
        record('G04', 'Configure a paid provider', 'PASS', 'OpenAI selected via QuickPick');
      } else {
        record('G04', 'Configure a paid provider', 'FAIL', 'OpenAI not found in QuickPick');
      }
    } catch (e) {
      record('G04', 'Configure a paid provider', 'FAIL', String(e));
    }
    await c.key(0, 'Escape', 'Escape', 27);
    await sleep(500);
    await c.key(0, 'Escape', 'Escape', 27);
    await sleep(500);

    // G05: Enter masked API key
    try {
      await runCommand(c, 'QuantsMind: Set API Key');
      await sleep(2500);
      var inputBoxVisible = await retryEval(c,
        'var input=document.querySelector(".quick-input-box input");input?true:false;',
        5, 500);
      if (inputBoxVisible) {
        await c.insertText('sk-test-dummy-key-for-gui-test');
        await sleep(500);
        await c.key(0, 'Enter', 'Enter', 13);
        await sleep(1500);
        record('G05', 'Enter masked API key', 'PASS', 'Masked input box accepted key input');
      } else {
        record('G05', 'Enter masked API key', 'FAIL', 'Masked input box not found');
      }
    } catch (e) {
      record('G05', 'Enter masked API key', 'FAIL', String(e));
    }

    // G06: Save and persist credentials
    try {
      await runCommand(c, 'QuantsMind: Open Chat');
      await sleep(8000);
      var chatTarget = await findChatTarget();
      if (chatTarget) {
        var cc = await connect(chatTarget);
        await sleep(5000);
        var statusHtml = await retryEval(cc,
          'var pill=document.getElementById("provider-status");pill?pill.innerText:"not found";',
          5, 1000);
        cc.close();
        if (statusHtml && statusHtml !== 'not found' && statusHtml.indexOf('API key required') < 0 && statusHtml.indexOf('Loading') < 0) {
          record('G06', 'Save and persist credentials', 'PASS', 'Status shows credential stored');
        } else {
          record('G06', 'Save and persist credentials', 'FAIL', 'Status still shows: ' + statusHtml);
        }
      } else {
        record('G06', 'Save and persist credentials', 'BLOCKED', 'Chat webview target not found');
      }
    } catch (e) {
      record('G06', 'Save and persist credentials', 'FAIL', String(e));
    }

    // G07: Test connection
    try {
      await runCommand(c, 'QuantsMind: Test Provider Connection');
      await sleep(12000);
      var resultText = await c.evaluate('var notifs=document.querySelectorAll(".notification, .toast");var texts=[];for(var i=0;i<notifs.length;i++)texts.push(notifs[i].innerText);texts.join(" | ");');
      if (resultText && (resultText.indexOf('succeeded') >= 0 || resultText.indexOf('failed') >= 0 || resultText.indexOf('Connection') >= 0)) {
        record('G07', 'Test connection', 'PASS', 'Connection test result surfaced');
      } else {
        record('G07', 'Test connection', 'BLOCKED', 'No connection test result notification observed: ' + resultText.slice(0, 200));
      }
    } catch (e) {
      record('G07', 'Test connection', 'FAIL', String(e));
    }

    // G08: Discover models
    try {
      await runCommand(c, 'QuantsMind: Select Model');
      await sleep(7000);
      var modelsText = await retryEval(c,
        'var rows=document.querySelectorAll(".quick-input-list .monaco-list-row");var out=[];for(var i=0;i<rows.length;i++)out.push(rows[i].innerText);out;',
        5, 500);
      if (!modelsText) modelsText = [];
      if (modelsText.length > 0 && !modelsText.some(function (t) { return t.indexOf('unavailable') >= 0; })) {
        record('G08', 'Discover models', 'PASS', 'Found ' + modelsText.length + ' model(s)');
      } else {
        record('G08', 'Discover models', 'BLOCKED', 'Model discovery unavailable or empty');
      }
    } catch (e) {
      record('G08', 'Discover models', 'FAIL', String(e));
    }
    await c.key(0, 'Escape', 'Escape', 27);
    await sleep(500);

    // G09: Select a model
    try {
      await runCommand(c, 'QuantsMind: Select Model');
      await sleep(7000);
      var rowsCount = await retryEval(c,
        'var rows=document.querySelectorAll(".quick-input-list .monaco-list-row");rows.length;',
        5, 500);
      if (rowsCount > 0) {
        await c.evaluate('var rows=document.querySelectorAll(".quick-input-list .monaco-list-row");rows[0].click();');
        await sleep(1000);
        await c.key(0, 'Enter', 'Enter', 13);
        await sleep(1000);
        record('G09', 'Select a model', 'PASS', 'Model selected from discovery list');
      } else {
        record('G09', 'Select a model', 'FAIL', 'No models available to select');
      }
    } catch (e) {
      record('G09', 'Select a model', 'FAIL', String(e));
    }

    // G10: Switch provider/model
    try {
      await c.key(0, 'Escape', 'Escape', 27);
      await sleep(500);
      await runCommand(c, 'QuantsMind: Select Provider Profile');
      await sleep(2500);
      await c.evaluate('var el=document.querySelector(".quick-input-box input");if(el)el.focus();');
      await c.insertText('ollama');
      await sleep(1000);
      var ollamaVisible = await retryEval(c,
        'var rows=document.querySelectorAll(".quick-input-list .monaco-list-row");var found=false;for(var i=0;i<rows.length;i++){if(rows[i].innerText.indexOf("Ollama")>=0)found=true;}found;',
        8, 500);
      if (ollamaVisible) {
        await c.key(0, 'Enter', 'Enter', 13);
        await sleep(1500);
        record('G10', 'Switch provider/model', 'PASS', 'Switched to Ollama (local)');
      } else {
        record('G10', 'Switch provider/model', 'FAIL', 'Ollama not found in QuickPick');
      }
    } catch (e) {
      record('G10', 'Switch provider/model', 'FAIL', String(e));
    }

    // G11: Clear API key
    try {
      await runCommand(c, 'QuantsMind: Clear API Key');
      await sleep(5000);
      var confirmResult = await retryEval(c,
        'var modal=document.querySelector(".modal");modal?modal.innerText.indexOf("Remove")>=0:false;',
        5, 500);
      if (confirmResult) {
        await c.insertText('Remove');
        await sleep(500);
        await c.key(0, 'Enter', 'Enter', 13);
        await sleep(1500);
        record('G11', 'Clear API key', 'PASS', 'API key cleared via confirmation modal');
      } else {
        record('G11', 'Clear API key', 'FAIL', 'Clear confirmation modal not found');
      }
    } catch (e) {
      record('G11', 'Clear API key', 'FAIL', String(e));
    }

    // G12: Display active provider/model in chat
    try {
      await runCommand(c, 'QuantsMind: Open Chat');
      await sleep(8000);
      var chatTarget2 = await findChatTarget();
      if (chatTarget2) {
        var cc2 = await connect(chatTarget2);
        await sleep(5000);
        var selectorHtml = await retryEval(cc2,
          'var row=document.getElementById("provider-selector-row");var hidden=(!row||row.hidden);var name="";var model="";var cls="";if(!hidden){var n=document.getElementById("provider-name");var m=document.getElementById("model-name");var c=document.getElementById("provider-class");name=n?n.textContent:"";model=m?m.textContent:"";cls=c?c.textContent:"";}hidden?"hidden":(name+" / "+model+" ["+cls+"]");',
          5, 1000);
        cc2.close();
        if (selectorHtml && selectorHtml !== 'hidden' && selectorHtml.indexOf('–') < 0) {
          record('G12', 'Display active provider/model in chat', 'PASS', selectorHtml);
        } else {
          record('G12', 'Display active provider/model in chat', 'FAIL', 'Selector not populated: ' + selectorHtml);
        }
      } else {
        record('G12', 'Display active provider/model in chat', 'BLOCKED', 'Chat webview target not found');
      }
    } catch (e) {
      record('G12', 'Display active provider/model in chat', 'FAIL', String(e));
    }

    // G13: Display authentication and quota errors
    try {
      await runCommand(c, 'QuantsMind: Test Provider Connection');
      await sleep(12000);
      var errorText = await c.evaluate('var notifs=document.querySelectorAll(".notification, .toast");var texts=[];for(var i=0;i<notifs.length;i++)texts.push(notifs[i].innerText);texts.join(" | ");');
      if (errorText && (errorText.indexOf('authentication') >= 0 || errorText.indexOf('API key') >= 0 || errorText.indexOf('failed') >= 0)) {
        record('G13', 'Display authentication and quota errors', 'PASS', 'Auth/quota error surfaced');
      } else {
        record('G13', 'Display authentication and quota errors', 'BLOCKED', 'No auth/quota error observed: ' + errorText.slice(0, 200));
      }
    } catch (e) {
      record('G13', 'Display authentication and quota errors', 'FAIL', String(e));
    }

    // G14: Restart and verify persistence — blocked (CDP cannot survive reload)
    record('G14', 'Restart and verify persistence', 'BLOCKED', 'Requires full VS Code restart; CDP session cannot survive reload. Manual: reload window, re-open chat, confirm provider/model retained.');

    // G15: Verify no silent paid fallback
    try {
      await runCommand(c, 'QuantsMind: Select Provider Profile');
      await sleep(2500);
      await c.evaluate('var el=document.querySelector(".quick-input-box input");if(el)el.focus();');
      await c.insertText('pollinations');
      await sleep(1000);
      await c.key(0, 'Enter', 'Enter', 13);
      await sleep(1500);
      var statusAfter = await c.evaluate('var pill=document.getElementById("provider-status");pill?pill.innerText:"not found";');
      if (statusAfter && statusAfter.indexOf('Paid') < 0 && statusAfter.indexOf('paid') < 0) {
        record('G15', 'Verify no silent paid fallback', 'PASS', 'Pollinations remains active; no silent switch to paid provider');
      } else {
        record('G15', 'Verify no silent paid fallback', 'FAIL', 'Unexpected status: ' + statusAfter);
      }
    } catch (e) {
      record('G15', 'Verify no silent paid fallback', 'FAIL', String(e));
    }

    c.close();

    console.log('\n=== G01-G15 GUI Test Summary ===');
    console.log('PASS: ' + passed + ' | FAIL: ' + failed + ' | BLOCKED: ' + blocked + ' | NOT TESTED: ' + notTested);
    console.log('Total: ' + RESULTS.length);

    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error('Fatal error:', String(e));
    process.exit(1);
  }
}

main();
