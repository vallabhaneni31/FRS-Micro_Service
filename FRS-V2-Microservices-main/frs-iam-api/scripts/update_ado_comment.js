const { execSync } = require('child_process');
const fs = require('fs');

/**
 * Enhanced script to update ADO Work Item:
 * 1. Links git branch as ArtifactLink
 * 2. Uploads test execution log / artifact file to ADO attachments
 * 3. Updates Completed / Remaining work hours
 * 4. Posts discussion comment with mandatory tags (@Kalyan Bapanapalli, @Ramya Yeluri, @Prashanth Pittla)
 * 5. Updates State to Resolved
 */

const PROJECT_ID = '84cdfa02-24b4-4b39-961e-e752a937630a';
const REPO_ID = '27ca3004-a8b0-46fe-a32a-74283b70dc21';
const ORG_URL = 'https://dev.azure.com/ML-AIML-COE';

function linkBranch(workItemId, branchName) {
  const encodedBranch = encodeURIComponent(`GB${branchName}`);
  const branchUrl = `vstfs:///Git/Ref/${PROJECT_ID}%2F${REPO_ID}%2F${encodedBranch}`;
  
  const patchBody = JSON.stringify([
    {
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'ArtifactLink',
        url: branchUrl,
        attributes: { name: 'Branch' }
      }
    }
  ]);

  try {
    const cmd = `az rest --method patch --uri "${ORG_URL}/Motivity-Face_Recognition_System/_apis/wit/workitems/${workItemId}?api-version=7.1" --headers "Content-Type=application/json-patch+json" --body '${patchBody}'`;
    execSync(cmd);
    console.log(`Successfully linked branch ${branchName} to AB#${workItemId}.`);
  } catch (err) {
    console.log(`Branch link note for AB#${workItemId}:`, err.message);
  }
}

function uploadTestArtifact(workItemId, filePath, comment = 'Test Case Execution Verification Log') {
  if (!fs.existsSync(filePath)) {
    console.warn(`File ${filePath} not found, skipping attachment.`);
    return;
  }
  
  try {
    const fileName = fs.statSync(filePath).isFile() ? filePath.split('/').pop().split('\\').pop() : 'test_results.txt';
    const uploadCmd = `az rest --method post --uri "${ORG_URL}/Motivity-Face_Recognition_System/_apis/wit/attachments?fileName=${fileName}&api-version=7.1" --headers "Content-Type=application/octet-stream" --body "@${filePath}" -o json`;
    const response = JSON.parse(execSync(uploadCmd).toString());
    const attachmentUrl = response.url;

    const patchBody = JSON.stringify([
      {
        op: 'add',
        path: '/relations/-',
        value: {
          rel: 'AttachedFile',
          url: attachmentUrl,
          attributes: { comment: comment }
        }
      }
    ]);

    const linkCmd = `az rest --method patch --uri "${ORG_URL}/Motivity-Face_Recognition_System/_apis/wit/workitems/${workItemId}?api-version=7.1" --headers "Content-Type=application/json-patch+json" --body '${patchBody}'`;
    execSync(linkCmd);
    console.log(`Successfully attached test artifact ${fileName} to AB#${workItemId}.`);
  } catch (err) {
    console.log(`Attachment note for AB#${workItemId}:`, err.message);
  }
}

function postAdoComment(workItemId, commentText, state = 'Resolved', completedWork = 2, remainingWork = 0) {
  const mentionsHtml = `<a href="#" data-vss-mention="version:2.0,55501b8b-1612-6679-8db8-9a2a26809118">@Kalyan Bapanapalli</a> <a href="#" data-vss-mention="version:2.0,5c837c39-c72c-61a2-b0d9-c9bf3e39adc3">@Ramya Yeluri</a> <a href="#" data-vss-mention="version:2.0,0a3fce53-ac20-6371-a518-3f4915be378e">@Prashanth Pittla</a><br><br>`;
  
  const fullDiscussion = `${mentionsHtml}${commentText}`;

  const updateCmd = `az boards work-item update --id ${workItemId} --state "${state}" --fields "Microsoft.VSTS.Scheduling.CompletedWork=${completedWork}" "Microsoft.VSTS.Scheduling.RemainingWork=${remainingWork}" --discussion "${fullDiscussion}" --org ${ORG_URL} -o json`;
  
  try {
    execSync(updateCmd);
    console.log(`Successfully updated ADO work item AB#${workItemId} state, hours, and tagged comment.`);
  } catch (err) {
    console.error(`Failed to update ADO work item AB#${workItemId}:`, err.message);
  }
}

module.exports = { linkBranch, uploadTestArtifact, postAdoComment };
