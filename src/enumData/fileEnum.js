const fileType=Object.freeze({
    PDF:'pdf',
    JPEG:'jpeg',
    PNG:'png',
    DOCX:'docx',
    txt:'txt'});
const fileTypeValue=Object.values(fileType);   
module.exports={
   fileType,
   fileTypeValue
};