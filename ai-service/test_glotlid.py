from huggingface_hub import hf_hub_download
import fasttext
import time


# 1. Download model
model_path = hf_hub_download(
    repo_id="cis-lmu/glotlid",
    filename="model.bin"
)

# print("Model downloaded to:")
# print(model_path)

# 2. Load model
model = fasttext.load_model(model_path)

print("GlotLID model loaded successfully!")



# 3. Detect language
text = "vayitru vali erpadum karanangal enna?"
start_time = time.perf_counter()
labels, probabilities = model.predict(text, k=1)
end_time = time.perf_counter()
detection_time = end_time - start_time

label = labels[0].replace("__label__", "")
confidence = float(probabilities[0])

language_codes = {
    "eng_Latn": "English",
    "guj_Latn": "Gujarati",
    "guj_Gujr": "Gujarati",
    "hin_Latn": "Hindi",
    "hin_Deva": "Hindi",
    "mar_Latn": "Marathi",
    "mar_Deva": "Marathi",
    "tam_Latn": "Tamil",
    "tam_Taml": "Tamil",
}

language_name = language_codes.get(label, label)

print("Text:", text)
print("Language:", language_name)
print("Confidence:", round(confidence * 100, 2), "%")
print("Detection time:", round(detection_time * 1000, 2), "ms")
print("Detection time:", round(detection_time, 4), "seconds")
