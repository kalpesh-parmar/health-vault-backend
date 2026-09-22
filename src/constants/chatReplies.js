const NO_CONTEXT_REPLY_I18N = {
  english: "Information not found in uploaded reports.",
  gujarati: "અપલોડ કરેલા અહેવાલોમાં આ માહિતી મળી નથી.",
  hindi: "अपलोड की गई रिपोर्ट में यह जानकारी नहीं मिली।",
  marathi: "अपलोड केलेल्या अहवालात ही माहिती आढळली नाही.",
  tamil: "பதிவேற்றப்பட்ட அறிக்கைகளில் இந்தத் தகவல் காணப்படவில்லை.",
};

const REQUIRE_SELECTION_I18N = {
  english: "Sure, please select your document that you have to compare.",
  gujarati: "ચોક્કસ, કૃપા કરીને તમારો દસ્તાવેજ પસંદ કરો જેની તમારે સરખામણી કરવી છે.",
  hindi: "ज़रूर, कृपया अपने उस दस्तावेज़ का चयन करें जिसकी आपको तुलना करनी है।",
  marathi: "नक्की, कृपया तुमचा दस्तऐवज निवडा ज्याची तुम्हाला तुलना करायची आहे.",
  tamil: "நிச்சயமாக, தயவுசெய்து நீங்கள் ஒப்பிட வேண்டிய உங்கள் ஆவணத்தைத் தேர்ந்தெடுக்கவும்.",
};

const AGE_REPLY_I18N = {
  english: {
    success: (dobStr, age) => `Based on your date of birth (${dobStr}), you are ${age} years old.`,
    missing: "Your date of birth is not specified in your profile, so I cannot calculate your age.",
  },
  gujarati: {
    success: (dobStr, age) => `તમારી જન્મ તારીખ (${dobStr}) ના આધારે, તમારી ઉંમર ${age} વર્ષ છે.`,
    missing:
      "તમારી જન્મ તારીખ તમારી પ્રોફાઇલમાં નિર્દિષ્ટ નથી, તેથી હું તમારી ઉંમરની ગણતરી કરી શકતો નથી.",
  },
  hindi: {
    success: (dobStr, age) => `आपकी जन्म तिथि (${dobStr}) के आधार पर, आपकी आयु ${age} वर्ष है।`,
    missing:
      "आपकी जन्म तिथि आपकी प्रोफ़ाइल में निर्दिष्ट नहीं है, इसलिए मैं आपकी आयु की गणना नहीं कर सकता।",
  },
  marathi: {
    success: (dobStr, age) => `तुमच्या जन्मतारखेनुसार (${dobStr}), तुमचे वय ${age} वर्षे आहे.`,
    missing:
      "तुमची जन्मतारीख तुमच्या प्रोफाइलमध्ये नमूद केलेली नाही, त्यामुळे मी तुमच्या वयाची गणना करू शकत नाही.",
  },
  tamil: {
    success: (dobStr, age) =>
      `உங்கள் பிறந்த தேதியின் (${dobStr}) அடிப்படையில், உங்கள் வயது ${age} ஆண்டுகள் ஆகும்.`,
    missing:
      "உங்கள் பிறந்த தேதி உங்கள் சுயவிவரத்தில் குறிப்பிடப்படவில்லை, எனவே என்னால் உங்கள் வயதைக் கணக்கிடுமாறு செய்ய முடியாது.",
  },
};

const SUMMARY_LABELS_I18N = {
  english: {
    patientName: "Patient Name",
    reportAge: "Report Age",
    summaryTitle: "Report Summary",
  },
  gujarati: {
    patientName: "દર્દીનું નામ",
    reportAge: "રિપોર્ટનો સમય",
    summaryTitle: "રિપોર્ટનો સારાંશ",
  },
  hindi: {
    patientName: "मरीज का नाम",
    reportAge: "रिपोर्ट की अवधि",
    summaryTitle: "रिपोर्ट का सारांश",
  },
  marathi: {
    patientName: "रुग्णाचे नाव",
    reportAge: "अहवालाचा कालावधी",
    summaryTitle: "अहवालाचा सारांश",
  },
  tamil: {
    patientName: "நோயாளி பெயர்",
    reportAge: "அறிக்கையின் வயது",
    summaryTitle: "அறிக்கையின் சுருக்கம்",
  },
};

const REPORT_PROCESSING_I18N = {
  english: "Your report is currently being processed. Please wait a moment.",
  gujarati: "તમારો રિપોર્ટ હાલમાં પ્રક્રિયા હેઠળ છે. કૃપા કરીને થોડી રાહ જુઓ.",
  hindi: "आपकी रिपोर्ट पर अभी प्रक्रिया चल रही है। कृपया कुछ समय प्रतीक्षा करें।",
  marathi: "तुमच्या अहवालावर सध्या प्रक्रिया सुरू आहे. कृपया काही वेळ थांबा.",
  tamil:
    "உங்கள் அறிக்கை தற்போது செயலாக்கப்பட்டு வருகிறது. தயவுசெய்து சிறிது நேரம் காத்திருக்கவும்.",
};

const NO_REPORT_FOUND_I18N = {
  english: "No active medical reports found in your profile.",
  gujarati: "તમારી પ્રોફાઇલમાં કોઈ સક્રિય તબીબી રિપોર્ટ મળ્યા નથી.",
  hindi: "आपकी प्रोफ़ाइल में कोई सक्रिय मेडिकल रिपोर्ट नहीं मिली।",
  marathi: "तुमच्या प्रोफाइलमध्ये कोणताही सक्रिय वैद्यकीय अहवाल आढळला नाही.",
  tamil: "உங்கள் சுயவிவரத்தில் செயலில் உள்ள மருத்துவ அறிக்கைகள் எதுவும் காணப்படவில்லை.",
};

const NO_SUMMARY_AVAILABLE_I18N = {
  english: "No summary details were found in this report.",
  gujarati: "આ રિપોર્ટમાં કોઈ સારાંશ વિગતો મળી નથી.",
  hindi: "इस रिपोर्ट में कोई सारांश विवरण नहीं मिला।",
  marathi: "या अहवालात कोणताही सारांश तपशील आढळला नाही.",
  tamil: "இந்த அறிக்கையில் சுருக்க விவரங்கள் எதுவும் காணப்படவில்லை.",
};

const PREDEFINED_QUESTIONS_I18N = {
  english: [
    "What are the key findings?",
    "Are there any abnormal values?",
    "What are the next steps or recommendations?",
  ],
  gujarati: [
    "મુખ્ય તારણો શું છે?",
    "શું કોઈ અસામાન્ય મૂલ્યો છે?",
    "આગળના પગલાં અથવા ભલામણો શું છે?",
  ],
  hindi: [
    "मुख्य निष्कर्ष क्या हैं?",
    "क्या कोई असामान्य मूल्य हैं?",
    "आगे के कदम या सिफारिशें क्या हैं?",
  ],
  marathi: [
    "मुख्य निष्कर्ष काय आहेत?",
    "काही असामान्य मूल्ये आहेत का?",
    "पुढील पावले किंवा शिफारसी काय आहेत?",
  ],
  tamil: [
    "முக்கிய கண்டுபிடிப்புகள் யாவை?",
    "ஏதேனும் அசாதாரண மதிப்புகள் உள்ளதா?",
    "அடுத்த படிகள் அல்லது பரிந்துரைகள் யாவை?",
  ],
};

const PROFILE_REPLY_I18N = {
  english: {
    title: "Official Profile Details:",
    name: "Name",
    email: "Email",
    mobile: "Mobile",
    dob: "Date of Birth",
    gender: "Gender",
    bloodGroup: "Blood Group",
    allergies: "Allergies",
    loginMethod: "Login Method",
    none: "None",
    notSpecified: "Not specified",
    unknown: "Unknown",
    specificName: (name) => `Your registered name is ${name}.`,
    specificBloodGroup: (bg) => `Your blood group is ${bg}.`,
    specificAllergies: (allergies) => `Your recorded allergies: ${allergies}.`,
    specificEmail: (email) => `Your registered email is ${email}.`,
    specificMobile: (mobile) => `Your registered mobile number is ${mobile}.`,
    specificLoginMethod: (method) => `You are logged in using ${method}.`,
  },
  gujarati: {
    title: "સત્તાવાર પ્રોફાઇલ વિગતો:",
    name: "નામ",
    email: "ઇમેઇલ",
    mobile: "મોબાઇલ",
    dob: "જન્મ તારીખ",
    gender: "જાતિ",
    bloodGroup: "બ્લડ ગ્રુપ",
    allergies: "એલર્જી",
    loginMethod: "લોગિન રીત",
    none: "કોઈ નહીં",
    notSpecified: "નિર્દિષ્ટ નથી",
    unknown: "અજ્ઞાત",
    specificName: (name) => `તમારું નોંધાયેલ નામ ${name} છે.`,
    specificBloodGroup: (bg) => `તમારું બ્લડ ગ્રુપ ${bg} છે.`,
    specificAllergies: (allergies) => `તમારી નોંધાયેલ એલર્જી: ${allergies}.`,
    specificEmail: (email) => `તમારો નોંધાયેલ ઇમેઇલ ${email} છે.`,
    specificMobile: (mobile) => `તમારો નોંધાયેલ મોબાઇલ નંબર ${mobile} છે.`,
    specificLoginMethod: (method) => `તમે ${method} વડે લોગિન કરેલ છો.`,
  },
  hindi: {
    title: "आधिकारिक प्रोफ़ाइल विवरण:",
    name: "नाम",
    email: "ईमेल",
    mobile: "मोबाइल",
    dob: "जन्म तिथि",
    gender: "लिंग",
    bloodGroup: "ब्लड ग्रुप",
    allergies: "एलर्जी",
    loginMethod: "लॉगिन का प्रकार",
    none: "कोई नहीं",
    notSpecified: "निर्दिष्ट नहीं",
    unknown: "अज्ञात",
    specificName: (name) => `आपका पंजीकृत नाम ${name} है।`,
    specificBloodGroup: (bg) => `आपका ब्लड ग्रुप ${bg} है।`,
    specificAllergies: (allergies) => `आपकी दर्ज एलर्जी: ${allergies}।`,
    specificEmail: (email) => `आपका पंजीकृत ईमेल ${email} है।`,
    specificMobile: (mobile) => `आपका पंजीकृत मोबाइल नंबर ${mobile} है।`,
    specificLoginMethod: (method) => `आप ${method} से लॉगिन हैं।`,
  },
  marathi: {
    title: "अधिकृत प्रोफाइल तपशील:",
    name: "नाव",
    email: "ईमेल",
    mobile: "मोबाइल",
    dob: "जन्मतारीख",
    gender: "लिंग",
    bloodGroup: "रक्तगट",
    allergies: "ऍलर्जी",
    loginMethod: "लॉगिन पद्धत",
    none: "काही नाही",
    notSpecified: "नमूद नाही",
    unknown: "अज्ञात",
    specificName: (name) => `तुमचे नोंदणीकृत नाव ${name} आहे.`,
    specificBloodGroup: (bg) => `तुमचा रक्तगट ${bg} आहे.`,
    specificAllergies: (allergies) => `तुमची नोंदवलेली ऍलर्जी: ${allergies}.`,
    specificEmail: (email) => `तुमचा नोंदणीकृत ईमेल ${email} आहे.`,
    specificMobile: (mobile) => `तुमचा नोंदणीकृत मोबाइल नंबर ${mobile} आहे.`,
    specificLoginMethod: (method) => `तुम्ही ${method} द्वारे लॉगिन केले आहे.`,
  },
  tamil: {
    title: "அதிகாரப்பூர்வ சுயவிவர விவரங்கள்:",
    name: "பெயர்",
    email: "மின்னஞ்சல்",
    mobile: "மொபைல்",
    dob: "பிறந்த தேதி",
    gender: "பாலினம்",
    bloodGroup: "இரத்த வகை",
    allergies: "ஒவ்வாமைகள்",
    loginMethod: "லாகின் முறை",
    none: "எதுவுமில்லை",
    notSpecified: "குறிப்பிடப்படவில்லை",
    unknown: "தெரியவில்லை",
    specificName: (name) => `உங்கள் பதிவு செய்யப்பட்ட பெயர் ${name}.`,
    specificBloodGroup: (bg) => `உங்கள் இரத்த வகை ${bg}.`,
    specificAllergies: (allergies) => `உங்கள் பதிவு செய்யப்பட்ட ஒவ்வாமைகள்: ${allergies}.`,
    specificEmail: (email) => `உங்கள் பதிவு செய்யப்பட்ட மின்னஞ்சல் ${email}.`,
    specificMobile: (mobile) => `உங்கள் பதிவு செய்யப்பட்ட மொபைல் எண் ${mobile}.`,
    specificLoginMethod: (method) => `நீங்கள் ${method} மூலம் உள்நுழைந்துள்ளீர்கள்.`,
  },
};

const REMINDER_REPLY_I18N = {
  english: {
    title: "Today's Medication Reminders:",
    total: "Total Scheduled Doses",
    taken: "Taken",
    pending: "Pending",
    missed: "Missed",
    noReminders: "You have no medication reminders scheduled for today.",
  },
  gujarati: {
    title: "આજના દવાના રિમાઇન્ડર્સ:",
    total: "કુલ નિર્ધારિત ડોઝ",
    taken: "લીધેલ",
    pending: "બાકી",
    missed: "ચૂકી ગયેલ",
    noReminders: "તમારી પાસે આજે કોઈ દવાનું રિમાઇન્ડર નિર્ધારિત નથી.",
  },
  hindi: {
    title: "आज के दवा रिमाइंडर:",
    total: "कुल निर्धारित खुराक",
    taken: "ली गई",
    pending: "लंबित",
    missed: "छूटी हुई",
    noReminders: "आज के लिए आपकी कोई दवा रिमाइंडर निर्धारित नहीं है।",
  },
  marathi: {
    title: "आजचे औषध स्मरणपत्रे:",
    total: "एकूण नियोजित डोस",
    taken: "घेतलेले",
    pending: "प्रलंबित",
    missed: "चुकलेले",
    noReminders: "आजसाठी तुमचे कोणतेही औषध स्मरणपत्र नियोजित नाही.",
  },
  tamil: {
    title: "இன்றைய மருந்து நினைவூட்டல்கள்:",
    total: "மொத்த திட்டமிடப்பட்ட மருந்தளவுகள்",
    taken: "எடுத்துக்கொண்டவை",
    pending: "நிலுவையில் உள்ளவை",
    missed: "தவறவிட்டவை",
    noReminders: "இன்று உங்களுக்கு எந்த மருந்து நினைவூட்டல்களும் திட்டமிடப்படவில்லை.",
  },
};

const REFILL_REPLY_I18N = {
  english: {
    title: "Medication Refill Status:",
    lowStock: "Low Stock / Refill Needed:",
    sufficientStock: "All active medications have sufficient stock.",
    noMeds: "No active medications found to track refills.",
    refillsLeft: "Refills Remaining",
    remainingStock: "Remaining Stock",
  },
  gujarati: {
    title: "દવા રિફિલ સ્થિતિ:",
    lowStock: "ઓછો જથ્થો / રિફિલ જરૂરી:",
    sufficientStock: "બધી ચાલુ દવાઓ પાસે પૂરતો જથ્થો છે.",
    noMeds: "રિફિલ ટ્રેક કરવા માટે કોઈ ચાલુ દવાઓ મળી નથી.",
    refillsLeft: "બાકી રિફિલ",
    remainingStock: "બાકી જથ્થો",
  },
  hindi: {
    title: "दवा रिफिल स्थिति:",
    lowStock: "कम स्टॉक / रिफिल की आवश्यकता:",
    sufficientStock: "सभी सक्रिय दवाओं का पर्याप्त स्टॉक है।",
    noMeds: "रिफिल ट्रैक करने के लिए कोई सक्रिय दवा नहीं मिली।",
    refillsLeft: "बची हुई रिफिल",
    remainingStock: "बचा हुआ स्टॉक",
  },
  marathi: {
    title: "औषध रिफिल स्थिती:",
    lowStock: "कमी साठा / रिफिल आवश्यक:",
    sufficientStock: "सर्व चालू औषधांचा पुरेसा साठा उपलब्ध आहे.",
    noMeds: "रिफिल ट्रॅक करण्यासाठी कोणतीही चालू औषधे आढळली नाहीत.",
    refillsLeft: "उरलेले रिफिल",
    remainingStock: "उरलेला साठा",
  },
  tamil: {
    title: "மருந்து மறு நிரப்பல் நிலை:",
    lowStock: "குறைந்த இருப்பு / மறு நிரப்பல் தேவை:",
    sufficientStock: "அனைத்து மருந்துகளும் போதுமான இருப்பில் உள்ளன.",
    noMeds: "மறு நிரப்பலைக் கண்காணிக்க எந்த மருந்துகளும் காணப்படவில்லை.",
    refillsLeft: "மீதமுள்ள மறு நிரப்பல்கள்",
    remainingStock: "மீதமுள்ள இருப்பு",
  },
};

const NOTIFICATION_REPLY_I18N = {
  english: {
    title: "Recent Notifications & Alerts:",
    total: "Total Notifications",
    unread: "Unread",
    read: "Read",
    noNotifs: "You have no notifications.",
  },
  gujarati: {
    title: "તાજેતરના નોટિફિકેશન અને અલર્ટ:",
    total: "કુલ નોટિફિકેશન",
    unread: "ન વંચાયેલ",
    read: "વંચાયેલ",
    noNotifs: "તમારી પાસે કોઈ નોટિફિકેશન નથી.",
  },
  hindi: {
    title: "हाल की सूचनाएं और अलर्ट:",
    total: "कुल सूचनाएं",
    unread: "अपठित",
    read: "पढ़ी गई",
    noNotifs: "आपकी कोई सूचना नहीं है।",
  },
  marathi: {
    title: "अलीकडील सूचना आणि सूचना:",
    total: "एकूण सूचना",
    unread: "न वाचलेले",
    read: "वाचलेले",
    noNotifs: "तुमच्याकडे कोणत्याही सूचना नाहीत.",
  },
  tamil: {
    title: "சமீபத்திய அறிவிப்புகள் மற்றும் எச்சரிக்கைகள்:",
    total: "மொத்த அறிவிப்புகள்",
    unread: "படிக்காதவை",
    read: "படித்தவை",
    noNotifs: "உங்களுக்கு அறிவிப்புகள் எதுவும் இல்லை.",
  },
};

module.exports = {
  NO_CONTEXT_REPLY_I18N,
  REQUIRE_SELECTION_I18N,
  AGE_REPLY_I18N,
  SUMMARY_LABELS_I18N,
  REPORT_PROCESSING_I18N,
  NO_REPORT_FOUND_I18N,
  NO_SUMMARY_AVAILABLE_I18N,
  PREDEFINED_QUESTIONS_I18N,
  PROFILE_REPLY_I18N,
  REMINDER_REPLY_I18N,
  REFILL_REPLY_I18N,
  NOTIFICATION_REPLY_I18N,
};
