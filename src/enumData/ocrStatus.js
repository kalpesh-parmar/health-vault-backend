const StatusType= Object.freeze({  
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    FAILED: 'failed'
});
const StatusTypeVale= Object.values(StatusType);
module.exports = {
    StatusType,
    StatusTypeVale
};