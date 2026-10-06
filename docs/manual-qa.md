# Manual QA Protocol: Premium Report Card Verification

This guide outlines end-to-end verification steps for the Phase 4 Premium Report Card UI, specifically covering localized Gujarati rendering, accessibility at 200% font scale, and dark mode compliance.

---

## Prerequisites

- Redacted fixture PDF generated via:
  ```bash
  cd health-vault-backend/ai-service
  .\venv\Scripts\python.exe scripts/redactFixture.py --test-fixtures
  ```
- Frontend application running with feature flag active:
  ```bash
  cd health-vault-frontend
  EXPO_PUBLIC_NEW_REPORT_CARDS=true npx expo start
  ```

---

## 1. Step-by-Step Upload & Report Card Test Flow

1. **Launch App**: Open the Expo Go client or web emulator.
2. **Switch Language to Gujarati**:
   - Navigate to Settings / Profile $\rightarrow$ Language Selection.
   - Choose **ગુજરાતી (Gujarati)**.
   - Confirm application switches to Gujarati localized strings.
3. **Upload Document**:
   - In the Documents / Chat tab, tap **Upload Report**.
   - Select the redacted 6-page digital PDF (`real_6page_digital.pdf`) from the temporary folder.
4. **Observe Processing States**:
   - While processing, verify that the **ReportCardSkeleton** displays with smooth pulse animation.
   - If reduced motion is enabled on the device, ensure the skeleton remains static without jarring animations.
5. **Review Rendered Report Card**:
   - Once completed, the new **StructuredReportSummaryCard** renders.

---

## 2. Expected Cards, Statuses & Visual Corridors

Verify that the following 8 representative parameters render with their expected status badges and RangeBar indicators:

| #   | Test Name              | Gujarati Label     | Value & Unit           | Status Badge              | RangeBar State                                                                             |
| --- | ---------------------- | ------------------ | ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | **Hemoglobin**         | હિમોગ્લોબિન        | `11.20 gm%`            | Blue (`ઓછું`)             | Marker positioned to the left of the green corridor ($11.20 < 12.0$).                      |
| 2   | **RBC Count**          | આરબીસી કાઉન્ટ      | `3.76 mill/cumm`       | Amber (`સીમારેખા`)        | Marker resting on the lower border threshold.                                              |
| 3   | **Prothrombin Time**   | પ્રોથ્રોમ્બિન ટાઇમ | `14.80 sec`            | Amber (`સીમારેખા વધારે`)  | Marker hovering at the upper corridor boundary.                                            |
| 4   | **Random Blood Sugar** | રેન્ડમ બ્લડ સુગર   | `185.00 mg/dL`         | Red (`વધારે`)             | Marker positioned in the right red overshoot zone.                                         |
| 5   | **HbA1c**              | એચબીએ૧સી           | `7.80 %`               | Purple (`ડાયાબિટીક સ્તર`) | Segmented multi-tier bar (3 colored zones); marker pinned in Red tier.                     |
| 6   | **INR**                | આઇએનઆર             | `2.40`                 | Gray (`સંદર્ભ નિર્ભર`)    | Continuous bar hidden; replaced by clear notice: _"લક્ષ્ય દર્દીના ઈલાજ પર નિર્ભર કરે છે"_. |
| 7   | **Neutrophils**        | ન્યુટ્રોફિલ્સ      | `68.0 %` / `4,760 /µL` | Green (`સામાન્ય`)         | Differential card displaying merged percentage and absolute count on one row.              |
| 8   | **Section Accordions** | વિભાગો             | —                      | —                         | Abnormal sections (Hematology, Biochemistry) auto-expanded; normal sections collapsed.     |

---

## 3. Dark Mode Verification

1. Toggle device setting to **Dark Mode** (or tap dark theme switch).
2. **Surface & Card Backgrounds**:
   - Card backgrounds switch to `#181A26` with subtle border contrast (`#2E334D`).
   - Inner metric rows switch to `#202434`.
3. **Text Contrast (WCAG AA)**:
   - Primary headers and values use pure white (`#FFFFFF`) or high-contrast tint.
   - Secondary labels and units use `#9CA3AF`.
   - Ensure zero unreadable dark-gray-on-black text.
4. **Status Pill Luminance**:
   - Status pills maintain darkened background tints with high-contrast foreground text (e.g. Red pill `#3B1E2B` background with `#F87171` text).

---

## 4. 200% Font Scale Accessibility Check

1. In iOS / Android system settings, set **Font Size / Dynamic Type** to maximum ($200\%$ / `fontScale = 2.0`).
2. **Text Wrapping & Truncation**:
   - Ensure zero text truncation (no `...` on analyte names or values).
   - Gujarati characters with matras (e.g. `િ`, `ી`, `ુ`, `ૂ`, `ો`) must render cleanly with line height $\ge 1.5\times$ font size without vertical clipping.
3. **Layout Adaptability**:
   - ParameterCard value and status badge stack vertically when horizontal space is constrained, rather than overflowing horizontally.
   - RangeBar markers and tick labels remain readable.
4. **Touch Targets**:
   - All interactive accordions, glossary info buttons, and action buttons maintain touch targets $\ge 44\times 44\text{ pt}$.

---

## 5. TalkBack / VoiceOver Screen Reader Audit

1. Activate **TalkBack** (Android) or **VoiceOver** (iOS).
2. Swipe through ParameterCard elements:
   - Verify speech announces the natural synthesized string:
     > _"હિમોગ્લોબિન: 11.2 ગ્રામ પ્રતિ ડેસિલિટર, ઓછું. સામાન્ય શ્રેણી: 12.0 થી 15.0."_
   - Verify units are spoken naturally rather than spelled letter-by-letter (`"milligrams per deciliter"` instead of `"m-g-slash-d-L"`).
3. Tap on the Glossary info icon:
   - Confirm TalkBack reads the accessible popup explanation clearly.
