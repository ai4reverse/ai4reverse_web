// Staged payload chain: base64 -> eval(stage 2) -> base64 -> eval(stage 3).
// The platform records each eval argument and stores the decoded stages as
// content-addressed artifacts (see report.artifacts).
(function () {
  var bootstrap = 'dmFyIHMzID0gYXRvYignWTI5dWMyOXNaUzVzYjJjb0ozTjBZV2RsTFRNZ1pYaGxZM1YwWldRbktUc2diRzlqWVd4VGRHOXlZV2RsTG5ObGRFbDBaVzBvSjNOMFlXZGxNeWNzSUNka2IyNWxKeWs3Jyk7IGV2YWwoczMpOw==';
  var stage2 = atob(bootstrap);
  console.log('stage-1 payload length', stage2.length);
  eval(stage2);
})();
