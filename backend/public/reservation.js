const CAR_NUMBER_RE = /^\d{2,3}[가-힣]\d{4}$/
const PHONE_RE = /^01[0-9]{8,9}$/

const mode = new URLSearchParams(location.search).get('mode') === 'payment' ? 'payment' : 'reservation'
// 플러그인이 탭앱으로 이 페이지를 띄울 때 자기 merchantId를 쿼리파라미터로 넘겨준다
// (예: index.html?merchantId=xxx&mode=payment). 없으면 서버가 가맹점을 식별할 수 없어 400을 반환한다.
const merchantId = new URLSearchParams(location.search).get('merchantId') || ''

const title = document.getElementById('title')
const subtitle = document.getElementById('subtitle')
const dots = document.querySelectorAll('.dot')
const serviceDot = document.querySelector('.dot[data-step="service"]')

const stepCar = document.getElementById('step-car')
const stepService = document.getElementById('step-service')
const stepPhone = document.getElementById('step-phone')
const stepDone = document.getElementById('step-done')

const carNumberInput = document.getElementById('carNumber')
const carError = document.getElementById('carError')
const toPhoneBtn = document.getElementById('toPhoneBtn')
const skipCarBtn = document.getElementById('skipCarBtn')

const serviceButtons = document.querySelectorAll('.service-opt')
const serviceError = document.getElementById('serviceError')
const toPhoneFromServiceBtn = document.getElementById('toPhoneFromServiceBtn')
const backFromServiceBtn = document.getElementById('backFromServiceBtn')

const phoneInput = document.getElementById('phone')
const amountWrap = document.getElementById('amountWrap')
const amountInput = document.getElementById('amount')
const phoneError = document.getElementById('phoneError')
const privacyConsentInput = document.getElementById('privacyConsent')
const marketingConsentInput = document.getElementById('marketingConsent')
const submitBtn = document.getElementById('submitBtn')
const submitBtnLabel = submitBtn.querySelector('.btn-label')
const submitBtnSpinner = submitBtn.querySelector('.spinner')
const backBtn = document.getElementById('backBtn')

const doneTitle = document.getElementById('doneTitle')
const doneMessage = document.getElementById('doneMessage')

let carNumber = ''
let serviceType = ''
const submitLabel = mode === 'payment' ? '영수증 받기' : '예약 완료'

// 서버가 idempotency/중복 결제 판별에 쓰는 키. 같은 제출 시도(네트워크 재시도 포함) 동안에는
// 값을 재사용해야 중복 Payment/Reservation 생성을 막을 수 있으므로, 처음 필요할 때 한 번만 생성해
// 모듈 스코프에 보관한다(성공/실패와 무관하게 페이지를 새로고침하기 전까지 동일한 값 유지).
let paymentKey = ''
let idempotencyKey = ''

if (mode === 'payment') {
  title.textContent = '결제 확인'
  amountWrap.classList.remove('hidden')
  skipCarBtn.classList.remove('hidden')
  submitBtnLabel.textContent = submitLabel
  // 결제 확인 플로우에는 정비 항목 선택 단계가 없다(서버도 요구하지 않음) — 점 표시에서도 숨긴다.
  if (serviceDot) serviceDot.classList.add('hidden')
}

function setStep(step) {
  stepCar.classList.toggle('hidden', step !== 'car')
  stepService.classList.toggle('hidden', step !== 'service')
  stepPhone.classList.toggle('hidden', step !== 'phone')
  stepDone.classList.toggle('hidden', step !== 'done')
  dots.forEach(dot => dot.classList.toggle('active', dot.dataset.step === step))
  if (step === 'car') subtitle.textContent = '차량번호를 입력해주세요'
  else if (step === 'service') subtitle.textContent = '정비 항목을 선택해주세요'
  else if (step === 'phone') subtitle.textContent = mode === 'payment' ? '전자영수증을 받으실 전화번호를 입력해주세요' : '전화번호를 입력해주세요'
  else subtitle.textContent = ''
}

function setSubmitting(isSubmitting) {
  submitBtn.disabled = isSubmitting
  submitBtnLabel.classList.toggle('hidden', isSubmitting)
  submitBtnSpinner.classList.toggle('hidden', !isSubmitting)
}

carNumberInput.addEventListener('input', () => {
  carError.textContent = ''
  toPhoneBtn.disabled = !CAR_NUMBER_RE.test(carNumberInput.value.trim())
})

carNumberInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !toPhoneBtn.disabled) goFromCarStep(carNumberInput.value.trim())
})

toPhoneBtn.addEventListener('click', () => goFromCarStep(carNumberInput.value.trim()))

skipCarBtn.addEventListener('click', () => goFromCarStep(''))

function goFromCarStep(value) {
  if (value && !CAR_NUMBER_RE.test(value)) {
    carError.textContent = '차량번호 형식이 올바르지 않습니다. 예) 12가3456'
    return
  }
  if (mode === 'reservation' && !value) {
    carError.textContent = '차량번호 형식이 올바르지 않습니다. 예) 12가3456'
    return
  }
  carNumber = value
  if (mode === 'reservation') {
    setStep('service')
  } else {
    // 결제 확인 플로우는 정비 항목이 필요 없으므로 바로 전화번호 단계로 이동한다.
    setStep('phone')
    phoneInput.focus()
  }
}

serviceButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    serviceType = btn.dataset.value
    serviceButtons.forEach(b => b.classList.toggle('selected', b === btn))
    serviceError.textContent = ''
    toPhoneFromServiceBtn.disabled = false
  })
})

toPhoneFromServiceBtn.addEventListener('click', () => {
  if (!serviceType) {
    serviceError.textContent = '정비 항목을 선택해주세요.'
    return
  }
  setStep('phone')
  phoneInput.focus()
})

backFromServiceBtn.addEventListener('click', () => {
  serviceError.textContent = ''
  setStep('car')
})

function updateSubmitState() {
  const phoneOk = PHONE_RE.test(phoneInput.value.replace(/-/g, '').trim())
  submitBtn.disabled = !phoneOk || !privacyConsentInput.checked
}

phoneInput.addEventListener('input', () => {
  phoneError.textContent = ''
  updateSubmitState()
})

phoneInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !submitBtn.disabled) submitReservation()
})

privacyConsentInput.addEventListener('change', updateSubmitState)

backBtn.addEventListener('click', () => {
  phoneError.textContent = ''
  setStep(mode === 'reservation' ? 'service' : 'car')
})

submitBtn.addEventListener('click', submitReservation)

async function submitReservation() {
  const phone = phoneInput.value.replace(/-/g, '').trim()
  const amount = amountInput.value.trim()

  if (!PHONE_RE.test(phone)) {
    phoneError.textContent = '전화번호 형식이 올바르지 않습니다.'
    return
  }
  if (!privacyConsentInput.checked) {
    phoneError.textContent = '개인정보 수집·이용에 동의해주세요.'
    return
  }
  if (!merchantId) {
    phoneError.textContent = '가맹점 정보가 없는 링크입니다. 담당 매장에 문의해주세요.'
    return
  }

  setSubmitting(true)

  try {
    const headers = { 'Content-Type': 'application/json' }
    let body

    if (mode === 'payment') {
      // paymentKey가 없으면 서버가 findPaymentByKey(null)로 항상 "새 결제"라고 판단해
      // 재시도/중복 클릭마다 Payment/영수증/프로모션이 중복 생성된다. 클라이언트에서 생성해 보낸다.
      if (!paymentKey) paymentKey = crypto.randomUUID()
      body = {
        carNumber,
        phone,
        amount: amount || undefined,
        merchantId,
        paymentKey,
        privacyConsent: privacyConsentInput.checked,
        marketingConsent: marketingConsentInput.checked,
      }
    } else {
      if (!idempotencyKey) idempotencyKey = crypto.randomUUID()
      headers['Idempotency-Key'] = idempotencyKey
      body = {
        carNumber,
        phone,
        serviceType,
        merchantId,
        privacyConsent: privacyConsentInput.checked,
        marketingConsent: marketingConsentInput.checked,
      }
    }

    const endpoint = mode === 'payment' ? '/api/payments' : '/api/reservations'
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => ({}))

    if (!res.ok) {
      phoneError.textContent = json.error || '처리 중 오류가 발생했습니다.'
      setSubmitting(false)
      return
    }

    if (mode === 'payment') {
      doneTitle.textContent = '전자영수증이 발송되었습니다'
      doneMessage.textContent = '알림톡을 확인해주세요.'
    } else {
      doneTitle.textContent = '예약이 접수되었습니다'
      doneMessage.textContent = `대기번호 ${json.queueNumber}번. 순서가 되면 알림톡으로 안내드려요.`
    }
    setStep('done')
  } catch (err) {
    phoneError.textContent = '네트워크 오류가 발생했습니다.'
    setSubmitting(false)
  }
}
