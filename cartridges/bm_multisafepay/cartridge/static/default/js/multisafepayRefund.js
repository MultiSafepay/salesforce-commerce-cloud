const submitButton = document.querySelector('#order-refund');

submitButton.addEventListener('click', async () => {
    const response = await fetch('MultisafepaySettings-RefundOrder', {
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      method: 'POST',
      body: JSON.stringify({
        amount: document.getElementById("amount").value,
        orderNumber: document.getElementById("order_number").value,
        currencyCode: document.getElementById("currency_code").value,
        invoiceNo: document.getElementById("invoice_no").value
      })
    });
    const data = await response.json();
    if(data.success){
      alert('Refund successful!');
    }else{
      alert('Refund failed: ' + data.data);
    }
});

// Manual Capture button
const captureButton = document.querySelector('#order-capture');
if (captureButton) {
    captureButton.addEventListener('click', async () => {
        if (!confirm('Are you sure you want to capture this payment?')) return;
        captureButton.disabled = true;
        captureButton.textContent = 'Capturing...';
        try {
            const response = await fetch('MultisafepaySettings-CaptureOrder', {
                headers: {
                    'Content-Type': 'application/json; charset=utf-8'
                },
                method: 'POST',
                body: JSON.stringify({
                    orderNumber: document.getElementById("order_number").value,
                    amount: null,
                    currencyCode: document.getElementById("currency_code").value
                })
            });
            const data = await response.json();
            if (data.success) {
                location.reload();
            } else {
                alert('Capture failed: ' + JSON.stringify(data.data || 'Unknown error'));
                captureButton.disabled = false;
                captureButton.textContent = 'CAPTURE PAYMENT';
            }
        } catch (e) {
            alert('Capture error: ' + e.message);
            captureButton.disabled = false;
            captureButton.textContent = 'CAPTURE PAYMENT';
        }
    });
}