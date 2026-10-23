const CAR_NUMBER_RE = /^\d{2,3}[가-힣]\d{4}$/
const PHONE_RE = /^01[0-9]{8,9}$/

// '12가 3456', '12가-3456'처럼 띄어 쓰거나 하이픈을 넣어도 받는다 -- 서버(normalizeCarNumber)와 같은 정규화다.
function normalizeCarNumber(raw) {
  return String(raw || '').replace(/[\s-]/g, '')
}

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
const submitLabel = mode === 'payment' ? '영수증 받기' : '접수하기'

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
  toPhoneBtn.disabled = !CAR_NUMBER_RE.test(normalizeCarNumber(carNumberInput.value))
})

carNumberInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !toPhoneBtn.disabled) goFromCarStep(normalizeCarNumber(carNumberInput.value))
})

toPhoneBtn.addEventListener('click', () => goFromCarStep(normalizeCarNumber(carNumberInput.value)))

skipCarBtn.addEventListener('click', () => goFromCarStep(''))

function goFromCarStep(value) {
  if (value && !CAR_NUMBER_RE.test(value)) {
    carError.textContent = '차량번호를 다시 확인해주세요. 예) 12가3456'
    return
  }
  if (mode === 'reservation' && !value) {
    carError.textContent = '차량번호를 다시 확인해주세요. 예) 12가3456'
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
    phoneError.textContent = '휴대폰 번호를 다시 확인해주세요. 예) 01012345678'
    return
  }
  if (!privacyConsentInput.checked) {
    phoneError.textContent = '개인정보 수집·이용에 동의해주세요.'
    return
  }
  if (!merchantId) {
    phoneError.textContent = '매장 정보를 확인할 수 없어요. 직원에게 문의해주세요.'
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

    // 실패하면 입력한 값을 그대로 두고 이 화면에 머문다 -- 접수가 몰려 한도에 걸린 경우(429 RATE_LIMITED)도 잠시 뒤 같은 버튼으로
    // 다시 보내면 된다(같은 Idempotency-Key라 두 번 접수되지 않는다).
    if (!res.ok) {
      phoneError.textContent = json.error || '처리 중 오류가 발생했어요. 잠시 후 다시 시도해주세요.'
      setSubmitting(false)
      return
    }

    if (mode === 'payment') {
      doneTitle.textContent = '전자영수증이 발송되었습니다'
      doneMessage.textContent = '알림톡을 확인해주세요.'
    } else {
      // duplicate: 같은 차·같은 번호가 오늘 이미 대기열에 있어 서버가 기존 접수를 돌려줬다(새 번호·새 알림 없음).
      // 이미 호출된(called·notify_failed) 접수면 호출 문자는 이미 나갔고(또는 실패했고) 다시 보내지 않는다 -- '알려드릴게요'라고 하면
      // 손님이 오지 않을 문자를 기다린다. 토스 프론트(showAccepted)와 같은 기준으로 직원에게 말하라고 안내한다.
      const alreadyCalled = json.duplicate && (json.status === 'called' || json.status === 'notify_failed')
      doneTitle.textContent = json.duplicate ? '이미 접수되어 있어요' : '접수했어요'
      doneMessage.textContent = alreadyCalled
        ? `대기번호는 ${json.queueNumber}번이에요. 이미 순서가 됐어요. 직원에게 말씀해주세요.`
        : `대기번호는 ${json.queueNumber}번이에요. 순서가 되면 메시지로 알려드릴게요.`
    }
    setStep('done')
  } catch (err) {
    phoneError.textContent = '인터넷 연결이 불안정해요. 잠시 후 다시 시도해주세요.'
    setSubmitting(false)
  }
}
