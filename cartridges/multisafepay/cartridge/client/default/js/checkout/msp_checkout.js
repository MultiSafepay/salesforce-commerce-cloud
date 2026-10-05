'use strict';

var mspPaymentComponent = null;
var currentGateway = null;

/**
 * Initializes the MSP Payment Component for a specific gateway (single mode).
 * Only used for gateways that require inline input (e.g. credit cards).
 * @param {string} gateway - the gateway ID (e.g. 'CREDITCARD', 'VISA')
 */
function initPaymentComponent(gateway) {
    if (!window.componentTokenURL) return;

    var container = document.getElementById('MultiSafepayPayment');
    if (!container) return;

    // Move container right after the selected method's row
    var selectedRadio = document.getElementById('msp_' + gateway);
    if (selectedRadio) {
        var methodRow = selectedRadio.closest('.msp-method-item');
        if (methodRow && methodRow.nextSibling !== container) {
            methodRow.parentNode.insertBefore(container, methodRow.nextSibling);
        }
    }

    // Clear previous component
    container.innerHTML = '';
    container.style.display = 'block';
    mspPaymentComponent = null;

    $.ajax({
        type: 'GET',
        url: window.componentTokenURL,
        dataType: 'json',
        success: function (response) {
            if (!response.success || !response.apiToken) return;

            try {
                mspPaymentComponent = new MultiSafepay({
                    env: response.environment,
                    apiToken: response.apiToken,
                    order: response.orderData
                });

                mspPaymentComponent.init('payment', {
                    container: '#MultiSafepayPayment',
                    gateway: gateway
                });
                currentGateway = gateway;
            } catch (e) {
                console.error('[MSP] Payment Component init error:', e);
            }
        }
    });
}

/**
 * Hides the Payment Component container.
 */
function hidePaymentComponent() {
    var container = document.getElementById('MultiSafepayPayment');
    if (container) {
        container.innerHTML = '';
        container.style.display = 'none';
    }
    mspPaymentComponent = null;
    currentGateway = null;
}

/**
 * Gets payment data from the component (for inline payment forms like cards).
 * @returns {Object|null} payment_data object or null if not available
 */
function getPaymentData() {
    if (!mspPaymentComponent) return null;

    try {
        var paymentData = mspPaymentComponent.getPaymentData();
        if (paymentData && paymentData.payload) {
            return paymentData;
        }
        // SDK v2 may wrap data inside payment_data property
        if (paymentData && paymentData.payment_data && paymentData.payment_data.payload) {
            return paymentData.payment_data;
        }
        // Return whatever the component gave if it's not empty
        if (paymentData && Object.keys(paymentData).length > 0) {
            return paymentData;
        }
    } catch (e) {
        console.error('[MSP] getPaymentData error:', e);
    }
    return null;
}

/**
 * Handles radio button selection of MSP payment methods.
 */
function initMethodSelection() {
    var radios = document.querySelectorAll('input[name="msp-payment-method"]');
    if (!radios.length) return;

    // Set initial gateway from pre-checked radio
    var checked = document.querySelector('input[name="msp-payment-method"]:checked');
    if (checked) {
        var gatewayField = document.getElementById('gatewayMSP');
        if (gatewayField) gatewayField.value = checked.value;

        if (checked.dataset.requiresComponent === 'true') {
            initPaymentComponent(checked.value);
        } else {
            hidePaymentComponent();
        }
    }

    // Listen for changes
    radios.forEach(function (radio) {
        radio.addEventListener('change', function () {
            var gatewayField = document.getElementById('gatewayMSP');
            if (gatewayField) gatewayField.value = this.value;

            if (this.dataset.requiresComponent === 'true') {
                initPaymentComponent(this.value);
            } else {
                hidePaymentComponent();
            }
        });
    });
}

// Initialize on page load
$(document).ready(function () {
    initMethodSelection();
});

// Re-initialize when going back to payment step (not when advancing to placeOrder)
$('body').on('checkout:updateCheckoutView', function () {
    var stage = $('.data-checkout-stage').data('checkout-stage');
    if (stage === 'payment') {
        initMethodSelection();
    }
});

// Stored payment data - captured before stage transition hides the component
var storedPaymentData = null;

var exports = {
    createOrder: function () {
        var result = {};

        // Get gateway from hidden field
        var gatewayField = document.getElementById('gatewayMSP');
        if (gatewayField && gatewayField.value) {
            result.gateway = gatewayField.value;
        }

        // Use stored payment_data (captured while component was still visible)
        if (storedPaymentData) {
            result.payment_data = JSON.stringify(storedPaymentData);
        }

        return result;
    },
    /**
     * Captures payment data from the component while it's still visible.
     * Must be called BEFORE the checkout stage transitions to placeOrder.
     */
    capturePaymentData: function () {
        var data = getPaymentData();
        console.log('[MSP] capturePaymentData called, result:', data);
        if (data) {
            storedPaymentData = data;
        }
        return data;
    },
    getPaymentData: getPaymentData,
    initPaymentComponent: initPaymentComponent,
    initMethodSelection: initMethodSelection
};

module.exports = exports;