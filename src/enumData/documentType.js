const documentType = Object.freeze({
    PRESCRIPTION: 'prescription',
    LAB_REPORT: 'lab_report',
    IMAGING_REPORT: 'imaging_report',
    DISCHARGE_SUMMARY: 'discharge_summary',
    OTHER: 'other'
}); 
const documentTypeValue = Object.values(documentType);
module.exports = {
    documentType,
    documentTypeValue
};