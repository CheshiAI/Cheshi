export const GITHUB_PULL_REQUEST_REVIEW_THREADS_QUERY = `query PullRequestReviewThreads($pullRequestId: ID!) {
  node(id: $pullRequestId) {
    ... on PullRequest {
      id
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          startDiffSide
          subjectType
          comments(first: 100) {
            nodes {
              id
              author { login }
              body
              createdAt
              url
              viewerDidAuthor
              state
            }
          }
        }
      }
      reviews(first: 10, states: [PENDING]) {
        nodes {
          id
          state
          author { login }
          comments { totalCount }
        }
      }
    }
  }
  viewer { login }
}`;

export const GITHUB_START_PULL_REQUEST_REVIEW_MUTATION = `mutation StartPullRequestReview(
  $pullRequestId: ID!
  $commitOID: GitObjectID!
  $path: String!
  $line: Int!
  $side: DiffSide!
  $body: String!
) {
  addPullRequestReview(input: {
    pullRequestId: $pullRequestId
    commitOID: $commitOID
    threads: [{ path: $path, line: $line, side: $side, body: $body }]
  }) {
    pullRequestReview { id state }
  }
}`;

export const GITHUB_ADD_PULL_REQUEST_REVIEW_THREAD_MUTATION = `mutation AddPullRequestReviewThread(
  $pullRequestReviewId: ID!
  $path: String!
  $line: Int!
  $side: DiffSide!
  $body: String!
) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $pullRequestReviewId
    path: $path
    line: $line
    side: $side
    body: $body
  }) {
    thread { id }
  }
}`;

export const GITHUB_SUBMIT_PULL_REQUEST_REVIEW_MUTATION = `mutation SubmitPullRequestReview(
  $pullRequestReviewId: ID!
  $event: PullRequestReviewEvent!
) {
  submitPullRequestReview(input: {
    pullRequestReviewId: $pullRequestReviewId
    event: $event
  }) {
    pullRequestReview { id state }
  }
}`;
