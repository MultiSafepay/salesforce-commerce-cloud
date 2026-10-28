document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('#settingsForm');
  const submitButton = document.querySelector('#settingsFormSubmitButton');
  const cancelButton = document.querySelector('#settingsFormCancelButton');
  const formButtons = Array.from(document.getElementsByClassName('formButton'));
  const changedSettings = [];

  form.addEventListener('change', event => {
    const {
      name
    } = event.target;
    let {
      value
    } = event.target; // get checked boolean value for checkboxes

    if (event.target.type === 'checkbox') {
      value = event.target.checked;
    }

    // convert radio button strings to boolean if values are 'true' or 'false'
    if (event.target.type === 'radio') {
      if (event.target.value === 'true') {
        value = true;
      }
      if (event.target.value === 'false') {
        value = false;
      }
    }
    settingChanged(name, value);
  });

  function settingChanged(key, value) {
    const settingIndex = changedSettings.findIndex(setting => setting.key === key);
    if (settingIndex >= 0) {
      changedSettings[settingIndex] = {
        key,
        value
      };
    } else {
      changedSettings.push({
        key,
        value
      });
    }
  }
  
  submitButton.addEventListener('click', async () => {
    // disable form buttons and reattach event listener for enabling it on form change
    console.log('Changed settings to be saved:', JSON.stringify(changedSettings));
    const response = await fetch('MultisafepaySettings-Save', {
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      method: 'POST',
      body: JSON.stringify({
        settings: changedSettings
      })
    });
    const data = await response.json();
    if (data.success) {
      const alertBar = document.getElementById('saveChangesAlert');
      alertBar.classList.add('show');
      window.setTimeout(() => {
        alertBar.classList.remove('show');
      }, 2000);
    } else {
      const cancelAlertBar = document.getElementById('notSavedChangesAlert');
      cancelAlertBar.classList.add('show');
      window.setTimeout(() => {
        cancelAlertBar.classList.remove('show');
      }, 2000);
    }
  });
  cancelButton.addEventListener('click', async () => {
    window.location.reload();
  });

  // --- Payment Methods Sync & Import (unified) ---
  const syncBtn = document.getElementById('syncPaymentMethodsBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing & Importing...';
      const importMsg = document.getElementById('importMessage');
      try {
        const response = await fetch('MultisafepaySettings-SyncPaymentMethods', {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          method: 'POST',
          body: JSON.stringify({})
        });
        const data = await response.json();
        if (data.success) {
          renderPaymentMethods(data.methods);
          if (importMsg) {
            if (data.importResult && data.importResult.success) {
              importMsg.className = 'alert alert-success small';
              importMsg.innerHTML = '<strong>Done!</strong> Synced ' + data.methods.length + ' methods. ' + data.importResult.message;
            } else {
              importMsg.className = 'alert alert-warning small';
              importMsg.innerHTML = '<strong>Synced OK</strong> (' + data.methods.length + ' methods), but import failed: ' + (data.importResult ? data.importResult.message : 'Unknown');
            }
            importMsg.style.display = 'block';
          }
        } else {
          if (importMsg) {
            importMsg.className = 'alert alert-danger small';
            importMsg.innerHTML = '<strong>Error:</strong> ' + (data.errorMessage || 'Unknown error');
            importMsg.style.display = 'block';
          }
        }
      } catch (e) {
        if (importMsg) {
          importMsg.className = 'alert alert-danger small';
          importMsg.innerHTML = '<strong>Error:</strong> ' + e.message;
          importMsg.style.display = 'block';
        }
      }
      syncBtn.disabled = false;
      syncBtn.innerHTML = '&#x21bb; Sync &amp; Import';
    });
  }

  // --- Payment Methods Toggle ---
  document.addEventListener('change', async (event) => {
    if (!event.target.classList.contains('msp-method-toggle')) return;
    const gatewayId = event.target.dataset.gateway;
    const enabled = event.target.checked;
    try {
      const response = await fetch('MultisafepaySettings-TogglePaymentMethod', {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        method: 'POST',
        body: JSON.stringify({ gatewayId: gatewayId, enabled: enabled })
      });
      const data = await response.json();
      if (!data.success) {
        alert('Toggle failed: ' + (data.errorMessage || 'Unknown error'));
        event.target.checked = !enabled; // revert
      }
    } catch (e) {
      alert('Toggle error: ' + e.message);
      event.target.checked = !enabled;
    }
  });

  function renderPaymentMethods(methods) {
    const list = document.getElementById('paymentMethodsList');
    if (!list) return;
    if (!methods || methods.length === 0) {
      list.innerHTML = '<p class="text-muted">No payment methods found.</p>';
      return;
    }
    let html = '';
    methods.forEach(function (method) {
      html += '<div class="row border py-2 mx-0 my-1 align-items-center payment-method-row" data-gateway="' + method.gatewayId + '">';
      html += '<div class="col-md-auto">';
      if (method.iconUrl) {
        html += '<img src="' + method.iconUrl + '" alt="' + method.name + '" width="40" class="msp-method-icon">';
      }
      html += '</div>';
      html += '<div class="col"><strong>' + method.name + '</strong>';
      html += '<small class="text-muted ml-2">(' + method.gatewayId + ')</small>';
      if (method.requiresComponent) {
        html += '<span class="badge badge-info ml-1">Inline</span>';
      }
      if (method.countries) {
        html += '<br><small class="text-muted">' + method.countries + '</small>';
      }
      html += '</div>';
      html += '<div class="col-md-auto"><div class="form-check form-switch">';
      html += '<input class="form-check-input msp-method-toggle" type="checkbox" data-gateway="' + method.gatewayId + '"' + (method.enabled ? ' checked' : '') + '>';
      html += '</div></div></div>';
    });
    list.innerHTML = html;
  }
});