---
dataset_info:
  features:
  - name: instance_id
    dtype: string
  - name: hints_text
    dtype: string
  - name: patch
    dtype: string
  - name: test_patch
    dtype: string
  - name: created_at
    dtype: string
  - name: problem_statement
    dtype: string
  - name: repo
    dtype: string
  - name: base_commit
    dtype: string
  - name: version
    dtype: string
  - name: PASS_TO_PASS
    sequence: string
  - name: FAIL_TO_PASS
    sequence: string
  splits:
  - name: train
    num_bytes: 213621640
    num_examples: 2438
  download_size: 43644473
  dataset_size: 213621640
configs:
- config_name: default
  data_files:
  - split: train
    path: data/train-*
license: mit
---

SWE-Gym contains 2438 instances sourced from 11 Python repos, following SWE-Bench data collection procedure.

**Get started at project page [github.com/SWE-Gym/SWE-Gym](https://github.com/SWE-Gym/SWE-Gym)**


![image/png](https://cdn-uploads.huggingface.co/production/uploads/61568f37272f2d87a99ba884/GHyyhROIieakMg6nuO0yH.png)

![image/png](https://cdn-uploads.huggingface.co/production/uploads/61568f37272f2d87a99ba884/gBKSiohnGKnp3toKw6H3Q.png)