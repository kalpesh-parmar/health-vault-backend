// const {Ollama} =require('ollama');
// const AI_CONFIG = require('../configs/aiConfig');
// const ollama= new Ollama({
//   host: AI_CONFIG.OLLAMA_URL,
// });
// class ollamaService{
//     async generate(prompt){

//         const model=AI_CONFIG.MODELS.OCR;
//         console.log("model",model);

//         const response= await ollama.chat({
//             model,
//             messages:[
//                 {
//                 role:'user',
//                 content:prompt,
//                 }
//             ]
//         });
//         return response.message.content;
//     }
// }
// module.exports= new ollamaService();
