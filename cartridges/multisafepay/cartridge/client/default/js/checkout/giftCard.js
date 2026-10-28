var $resultsDiv = $('.gift-cart-component');

$('.remove-giftcert').on('click', function (e) {
    removeGiftCertificate(e);
});

$('.btn-add-giftcert').on('click', function (e) {
    //get data from input field
    e.preventDefault();
    let giftCert = document.getElementById("giftCertCode");
    giftCert.classList.remove('is-invalid');
    $('.gift-cert-error').text('');
    if(giftCert.value!=null && giftCert.value!=''){
        $resultsDiv.spinner().start();
        $.ajax({
            type: 'GET',
            url: window.validateGift,
            dataType: 'json',
            data: {'giftCert': giftCert.value},
            success: function success(data) {
                if(data.success){
                    if(data.giftCardTemplate){
                        $resultsDiv.empty().html(data.giftCardTemplate);
                        $('.remove-giftcert').on('click', function (e) {
                            removeGiftCertificate(e);
                        });
                    }
                    $resultsDiv.spinner().stop();
                }else{
                    $resultsDiv.spinner().stop();
                    console.log('Error: '+data.errorMessage);
                    $('.gift-cert-error').text(data.errorMessage);
                }
            }
        });
    }else{
        giftCert.classList.add('is-invalid');
    }
});

function removeGiftCertificate(e) {
    e.preventDefault();
    $.ajax({
        type: 'GET',
        url: window.removeGiftCard,
        dataType: 'json',
        success: function success(data) {
            if(data.success){
                $resultsDiv.empty();
            }else{
                console.log('Error: '+data.errorMessage);
                $('.gift-cert-error').text(data.errorMessage);
            }
        }
    });
}